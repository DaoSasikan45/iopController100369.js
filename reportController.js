// controllers/reportController.js
const pool = require('../config/database');

/**
 * สรุปรายงานรายเดือน
 * GET /api/reports/monthly-summary/:doctorId
 * 
 * Query params:
 * - month: เดือน (required, 1-12)
 * - year: ปี (required, YYYY)
 */
const getMonthlySummary = async (req, res) => {
  let connection;

  try {
    const { doctorId } = req.params;
    const { month, year } = req.query;

    const tokenDoctorId = req.doctor?.doctor_id || req.user?.doctor_id;
    if (!tokenDoctorId) {
      return res.status(401).json({
        success: false,
        message: 'ไม่พบข้อมูลแพทย์จาก token',
        error: 'NO_TOKEN_DOCTOR'
      });
    }
    
    // 1. Validate doctorId
    if (!doctorId || typeof doctorId !== 'string' || doctorId.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'รูปแบบ doctor_id ไม่ถูกต้อง',
        error: 'INVALID_DOCTOR_ID'
      });
    }
    
    // 2. ตรวจสอบว่า doctorId ตรงกับ token หรือไม่
    if (doctorId !== tokenDoctorId) {
      return res.status(403).json({
        success: false,
        message: 'คุณไม่มีสิทธิ์ดูรายงานของแพทย์คนอื่น',
        error: 'UNAUTHORIZED_ACCESS'
      });
    }
    
    // 3. Validate month
    if (!month) {
      return res.status(400).json({
        success: false,
        message: 'กรุณาระบุเดือน (month)',
        error: 'MONTH_REQUIRED'
      });
    }
    
    const monthInt = parseInt(month);
    if (isNaN(monthInt) || monthInt < 1 || monthInt > 12) {
      return res.status(400).json({
        success: false,
        message: 'month ต้องเป็นตัวเลข 1-12',
        error: 'INVALID_MONTH'
      });
    }
    
    // 4. Validate year
    if (!year) {
      return res.status(400).json({
        success: false,
        message: 'กรุณาระบุปี (year)',
        error: 'YEAR_REQUIRED'
      });
    }
    
    const yearInt = parseInt(year);
    const currentYear = new Date().getFullYear();
    if (isNaN(yearInt) || yearInt < 2000 || yearInt > currentYear + 10) {
      return res.status(400).json({
        success: false,
        message: `year ต้องเป็นตัวเลข 2000-${currentYear + 10}`,
        error: 'INVALID_YEAR'
      });
    }
    
    // 5. Get connection
    try {
      connection = await pool.getConnection();
    } catch (connError) {
      console.error('❌ Database Connection Error:', connError);
      return res.status(503).json({
        success: false,
        message: 'ไม่สามารถเชื่อมต่อฐานข้อมูลได้',
        error: 'DATABASE_CONNECTION_ERROR'
      });
    }
    
    // 6. สร้างช่วงวันที่
    const startDate = `${yearInt}-${String(monthInt).padStart(2, '0')}-01 00:00:00`;
    const lastDay = new Date(yearInt, monthInt, 0).getDate();
    const endDate = `${yearInt}-${String(monthInt).padStart(2, '0')}-${lastDay} 23:59:59`;
    
    // 7. นับจำนวนผู้ป่วยทั้งหมด
    const [totalPatientsResult] = await connection.execute(
      `SELECT COUNT(DISTINCT patient_id) as total_patients
       FROM (
         SELECT patient_id FROM GlaucomaDiagnosis WHERE doctor_id = ?
         UNION
         SELECT patient_id FROM GlaucomaTreatmentPlans WHERE doctor_id = ?
         UNION
         SELECT patient_id FROM PatientVisits WHERE doctor_id = ?
       ) AS all_patients`,
      [doctorId, doctorId, doctorId]
    );
    
    const totalPatients = totalPatientsResult[0].total_patients;
    
    // 8. คำนวณ Compliance Rate
    const [complianceResult] = await connection.execute(
      `SELECT 
         COUNT(*) as total_logs,
         SUM(CASE WHEN mur.status = 'taken' THEN 1 ELSE 0 END) as taken_count
       FROM MedicationUsageRecords mur
       JOIN PatientMedications pm ON mur.medication_id = pm.medication_id AND mur.patient_id = pm.patient_id
       WHERE pm.doctor_id = ?
         AND mur.scheduled_time >= ?
         AND mur.scheduled_time <= ?`,
      [doctorId, startDate, endDate]
    );
    
    let avgComplianceRate = null;
    if (complianceResult[0].total_logs > 0) {
      avgComplianceRate = ((complianceResult[0].taken_count / complianceResult[0].total_logs) * 100).toFixed(2);
    }
    
    // 9. นับจำนวนนัดหมาย
    const [appointmentsResult] = await connection.execute(
      `SELECT 
         COUNT(*) as total_appointments,
         SUM(CASE WHEN appointment_status = 'scheduled' THEN 1 ELSE 0 END) as scheduled,
         SUM(CASE WHEN appointment_status = 'completed' THEN 1 ELSE 0 END) as completed,
         SUM(CASE WHEN appointment_status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
         SUM(CASE WHEN appointment_status = 'rescheduled' THEN 1 ELSE 0 END) as rescheduled,
         SUM(CASE WHEN appointment_status = 'no_show' THEN 1 ELSE 0 END) as no_show
       FROM Appointments
       WHERE doctor_id = ?
         AND appointment_date >= DATE(?)
         AND appointment_date <= DATE(?)`,
      [doctorId, startDate, endDate]
    );
    
    const appointmentsStats = appointmentsResult[0];
    
    // 10. หาผู้ป่วยที่มี IOP เกิน Target
    const [highIOPResult] = await connection.execute(
      `SELECT DISTINCT
         iop.patient_id,
         p.first_name,
         p.last_name,
         MAX(GREATEST(COALESCE(iop.left_eye_iop, 0), COALESCE(iop.right_eye_iop, 0))) as max_iop,
         gtp.target_iop_left,
         gtp.target_iop_right
       FROM IOP_Measurements iop
       JOIN PatientProfiles p ON iop.patient_id = p.patient_id
       LEFT JOIN GlaucomaTreatmentPlans gtp ON iop.patient_id = gtp.patient_id AND gtp.doctor_id = ?
       WHERE iop.patient_id IN (
         SELECT DISTINCT patient_id FROM (
           SELECT patient_id FROM GlaucomaDiagnosis WHERE doctor_id = ?
           UNION
           SELECT patient_id FROM GlaucomaTreatmentPlans WHERE doctor_id = ?
           UNION
           SELECT patient_id FROM PatientVisits WHERE doctor_id = ?
         ) AS doctor_patients
       )
         AND iop.measurement_date >= DATE(?)
         AND iop.measurement_date <= DATE(?)
       GROUP BY iop.patient_id, p.first_name, p.last_name, gtp.target_iop_left, gtp.target_iop_right
       HAVING MAX(iop.left_eye_iop) > COALESCE(gtp.target_iop_left, 21) 
           OR MAX(iop.right_eye_iop) > COALESCE(gtp.target_iop_right, 21)`,
      [doctorId, doctorId, doctorId, doctorId, startDate, endDate]
    );
    
    const patientsWithHighIOP = highIOPResult.map(patient => ({
      patient_id: patient.patient_id,
      name: `${patient.first_name} ${patient.last_name}`,
      max_iop: patient.max_iop ? parseFloat(patient.max_iop) : null,
      target_left: patient.target_iop_left ? parseFloat(patient.target_iop_left) : 21,
      target_right: patient.target_iop_right ? parseFloat(patient.target_iop_right) : 21
    }));
    
    // 11. นับยอดยาที่สั่ง
    const [medicationsResult] = await connection.execute(
      `SELECT 
         COUNT(*) as total_prescriptions,
         COUNT(DISTINCT patient_id) as patients_with_medications,
         COUNT(DISTINCT medication_id) as unique_medications,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
         SUM(CASE WHEN status = 'discontinued' THEN 1 ELSE 0 END) as discontinued
       FROM PatientMedications
       WHERE doctor_id = ?
         AND created_at >= ?
         AND created_at <= ?`,
      [doctorId, startDate, endDate]
    );
    
    const medicationsStats = medicationsResult[0];
    
    // 12. ยาที่สั่งบ่อยที่สุด (Top 5)
    const [topMedicationsResult] = await connection.execute(
      `SELECT 
         m.medication_id,
         m.name as medication_name,
         m.generic_name,
         COUNT(*) as prescription_count
       FROM PatientMedications pm
       JOIN Medications m ON pm.medication_id = m.medication_id
       WHERE pm.doctor_id = ?
         AND pm.created_at >= ?
         AND pm.created_at <= ?
       GROUP BY m.medication_id, m.name, m.generic_name
       ORDER BY prescription_count DESC
       LIMIT 5`,
      [doctorId, startDate, endDate]
    );
    
    const topMedications = topMedicationsResult.map(m => ({
      medication_id: m.medication_id,
      medication_name: m.medication_name,
      generic_name: m.generic_name,
      prescription_count: m.prescription_count
    }));
    
    // 13. นับผู้ป่วยใหม่
    const [newPatientsResult] = await connection.execute(
      `SELECT COUNT(DISTINCT patient_id) as new_patients
       FROM GlaucomaDiagnosis
       WHERE doctor_id = ?
         AND diagnosis_date >= DATE(?)
         AND diagnosis_date <= DATE(?)`,
      [doctorId, startDate, endDate]
    );
    
    const newPatients = newPatientsResult[0].new_patients;
    
    // 14. คำนวณ IOP เฉลี่ย
    const [avgIOPResult] = await connection.execute(
      `SELECT 
         AVG(left_eye_iop) as avg_left_iop,
         AVG(right_eye_iop) as avg_right_iop,
         COUNT(*) as total_measurements
       FROM IOP_Measurements
       WHERE patient_id IN (
         SELECT DISTINCT patient_id FROM (
           SELECT patient_id FROM GlaucomaDiagnosis WHERE doctor_id = ?
           UNION
           SELECT patient_id FROM GlaucomaTreatmentPlans WHERE doctor_id = ?
           UNION
           SELECT patient_id FROM PatientVisits WHERE doctor_id = ?
         ) AS doctor_patients
       )
         AND measurement_date >= DATE(?)
         AND measurement_date <= DATE(?)`,
      [doctorId, doctorId, doctorId, startDate, endDate]
    );
    
    const iopStats = {
      avg_left_iop: avgIOPResult[0].avg_left_iop !== null ? 
        parseFloat(avgIOPResult[0].avg_left_iop).toFixed(2) : null,
      avg_right_iop: avgIOPResult[0].avg_right_iop !== null ? 
        parseFloat(avgIOPResult[0].avg_right_iop).toFixed(2) : null,
      total_measurements: avgIOPResult[0].total_measurements
    };
    
    // 15. สร้าง summary
    const monthNames = [
      'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
      'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
    ];
    
    const monthNamesEn = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    
    const getComplianceRating = (rate) => {
      if (rate === null) return 'ไม่มีข้อมูล';
      if (rate >= 90) return 'ดีมาก';
      if (rate >= 80) return 'ดี';
      if (rate >= 70) return 'พอใช้';
      if (rate >= 60) return 'ปรับปรุง';
      return 'ต้องดูแลเร่งด่วน';
    };
    
    const summary = {
      period: {
        month: monthInt,
        year: yearInt,
        month_name_thai: monthNames[monthInt - 1],
        month_name_english: monthNamesEn[monthInt - 1],
        start_date: startDate.split(' ')[0],
        end_date: endDate.split(' ')[0]
      },
      patients: {
        total_patients: totalPatients,
        new_patients: newPatients,
        patients_with_high_iop: patientsWithHighIOP.length,
        high_iop_percentage: totalPatients > 0 ? 
          ((patientsWithHighIOP.length / totalPatients) * 100).toFixed(2) : 
          "0.00"
      },
      medication_compliance: {
        total_logs: complianceResult[0].total_logs,
        taken_count: complianceResult[0].taken_count,
        avg_compliance_rate: avgComplianceRate !== null ? parseFloat(avgComplianceRate) : null,
        rating: getComplianceRating(avgComplianceRate !== null ? parseFloat(avgComplianceRate) : null)
      },
      appointments: {
        total_appointments: appointmentsStats.total_appointments,
        by_status: {
          scheduled: appointmentsStats.scheduled || 0,
          completed: appointmentsStats.completed || 0,
          cancelled: appointmentsStats.cancelled || 0,
          rescheduled: appointmentsStats.rescheduled || 0,
          no_show: appointmentsStats.no_show || 0
        },
        completion_rate: appointmentsStats.total_appointments > 0 ?
          ((appointmentsStats.completed / appointmentsStats.total_appointments) * 100).toFixed(2) :
          "0.00"
      },
      iop: {
        avg_left_iop: iopStats.avg_left_iop !== null ? parseFloat(iopStats.avg_left_iop) : null,
        avg_right_iop: iopStats.avg_right_iop !== null ? parseFloat(iopStats.avg_right_iop) : null,
        total_measurements: iopStats.total_measurements,
        patients_with_high_iop: patientsWithHighIOP
      },
      medications: {
        total_prescriptions: medicationsStats.total_prescriptions,
        unique_medications: medicationsStats.unique_medications || 0,
        patients_with_medications: medicationsStats.patients_with_medications || 0,
        by_status: {
          active: medicationsStats.active || 0,
          completed: medicationsStats.completed || 0,
          discontinued: medicationsStats.discontinued || 0
        },
        top_medications: topMedications
      }
    };
    
    // 16. ส่ง response
    return res.status(200).json({
      success: true,
      message: `รายงานประจำเดือน ${monthNames[monthInt - 1]} ${yearInt}`,
      data: summary
    });
    
  } catch (error) {
    console.error('❌ Get Monthly Summary Error:', error);
    
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      return res.status(503).json({
        success: false,
        message: 'การเชื่อมต่อฐานข้อมูลขาดหาย',
        error: 'DATABASE_CONNECTION_LOST'
      });
    }
    
    return res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการสร้างรายงาน',
      error: process.env.NODE_ENV === 'development' ? error.message : 'INTERNAL_SERVER_ERROR'
    });
    
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

/**
 * ภาพรวม Compliance Rate ของผู้ป่วยทั้งหมด
 * GET /api/reports/compliance-overview/:doctorId
 */
const getComplianceOverview = async (req, res) => {
  let connection;

  try {
    const { doctorId } = req.params;

    const tokenDoctorId = req.doctor?.doctor_id || req.user?.doctor_id;
    if (!tokenDoctorId) {
      return res.status(401).json({
        success: false,
        message: 'ไม่พบข้อมูลแพทย์จาก token',
        error: 'NO_TOKEN_DOCTOR'
      });
    }

    // ... โค้ดเดิมต่อ
    
    // 1. Validate doctorId
    if (!doctorId || typeof doctorId !== 'string' || doctorId.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'รูปแบบ doctor_id ไม่ถูกต้อง',
        error: 'INVALID_DOCTOR_ID'
      });
    }
    
    // 2. ตรวจสอบว่า doctorId ตรงกับ token หรือไม่
    if (doctorId !== tokenDoctorId) {
      return res.status(403).json({
        success: false,
        message: 'คุณไม่มีสิทธิ์ดูรายงานของแพทย์คนอื่น',
        error: 'UNAUTHORIZED_ACCESS'
      });
    }
    
    // 3. Get connection
    try {
      connection = await pool.getConnection();
    } catch (connError) {
      console.error('❌ Database Connection Error:', connError);
      return res.status(503).json({
        success: false,
        message: 'ไม่สามารถเชื่อมต่อฐานข้อมูลได้',
        error: 'DATABASE_CONNECTION_ERROR'
      });
    }
    
    // 4. ดึงผู้ป่วยทั้งหมดของแพทย์ (ผ่าน PatientMedications เป็นหลัก + fallback union)
    const [patients] = await connection.execute(
      `SELECT DISTINCT
         p.patient_id,
         p.first_name,
         p.last_name,
         p.patient_hn
       FROM PatientProfiles p
       WHERE p.patient_id IN (
         SELECT DISTINCT patient_id FROM PatientMedications WHERE doctor_id = ?
         UNION
         SELECT DISTINCT patient_id FROM GlaucomaDiagnosis WHERE doctor_id = ?
         UNION
         SELECT DISTINCT patient_id FROM GlaucomaTreatmentPlans WHERE doctor_id = ?
         UNION
         SELECT DISTINCT patient_id FROM PatientVisits WHERE doctor_id = ?
       )`,
      [doctorId, doctorId, doctorId, doctorId]
    );

    if (patients.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'ไม่พบผู้ป่วยของแพทย์คนนี้',
        data: {
          summary: { total_patients: 0, green_count: 0, red_count: 0, no_data_count: 0 },
          groups: [
            { group: 'good', label: 'หยอดยาครบทุกรอบ', count: 0, percentage: '0.00', patient_list: [] },
            { group: 'needs_attention', label: 'พลาดการหยอดยา', count: 0, percentage: '0.00', patient_list: [] },
            { group: 'no_data', label: 'ไม่มีข้อมูล', count: 0, percentage: '0.00', patient_list: [] }
          ]
        }
      });
    }

    // 5. คำนวณ compliance แบบใหม่ (วันนี้เป็นหลัก, fallback 30 วัน)
    // rule: ต้องหยอดครบ 100% ของรอบที่ถึงกำหนดแล้ว ถึงจะเป็น "เขียว"
    // พลาดแม้แต่ 1 รอบ = "แดง"
    const patientComplianceData = [];

    for (const patient of patients) {
      // นับเฉพาะรอบที่ถึงกำหนดแล้ว (scheduled_datetime <= NOW) ใน 30 วัน
      const [logStats] = await connection.execute(
        `SELECT
           COUNT(*) AS total_logs,
           SUM(CASE WHEN ml.status = 'completed' THEN 1 ELSE 0 END) AS taken_count,
           SUM(CASE WHEN ml.status != 'completed' THEN 1 ELSE 0 END) AS missed_count
         FROM MedicationLogs ml
         WHERE ml.patient_id = ?
           AND ml.scheduled_datetime <= NOW()
           AND DATE(ml.scheduled_datetime) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`,
        [patient.patient_id]
      );

      const totalLogs  = Number(logStats[0].total_logs)  || 0;
      const takenCount = Number(logStats[0].taken_count) || 0;
      const missedCount = Number(logStats[0].missed_count) || 0;

      // compliance_rate = % ที่หยอดครบ
      const complianceRate = totalLogs > 0
        ? parseFloat(((takenCount / totalLogs) * 100).toFixed(2))
        : null;

      // rule ใหม่: ต้องหยอดครบ 100% (missedCount === 0 AND totalLogs > 0) ถึงจะเขียว
      let complianceGroup = 'no_data';
      if (totalLogs > 0) {
        complianceGroup = missedCount === 0 ? 'good' : 'needs_attention';
      }

      patientComplianceData.push({
        patient_id:       patient.patient_id,
        name:             `${patient.first_name} ${patient.last_name}`,
        patient_hn:       patient.patient_hn,
        total_logs:       totalLogs,
        taken_count:      takenCount,
        missed_count:     missedCount,
        compliance_rate:  complianceRate,
        compliance_group: complianceGroup,
      });
    }

    // 6. จัดกลุ่ม
    const groupedData = {
      good: {
        group: 'good',
        label: 'หยอดยาครบทุกรอบ ',
        description: 'ผู้ป่วยที่หยอดยาครบทุกรอบใน 30 วันที่ผ่านมา',
        count: 0, percentage: '0.00', patient_list: []
      },
      needs_attention: {
        group: 'needs_attention',
        label: 'พลาดการหยอดยา ',
        description: 'ผู้ป่วยที่พลาดการหยอดยาอย่างน้อย 1 รอบใน 30 วัน',
        count: 0, percentage: '0.00', patient_list: []
      },
      no_data: {
        group: 'no_data',
        label: 'ไม่มีข้อมูล',
        description: 'ยังไม่มีบันทึกการหยอดยา',
        count: 0, percentage: '0.00', patient_list: []
      }
    };

    patientComplianceData.forEach(p => {
      const g = groupedData[p.compliance_group];
      g.count++;
      g.patient_list.push({
        patient_id:      p.patient_id,
        name:            p.name,
        patient_hn:      p.patient_hn,
        compliance_rate: p.compliance_rate,
        total_logs:      p.total_logs,
        taken_count:     p.taken_count,
        missed_count:    p.missed_count,
      });
    });

    const totalPatients = patients.length;
    Object.keys(groupedData).forEach(key => {
      groupedData[key].percentage = ((groupedData[key].count / totalPatients) * 100).toFixed(2);
    });

    // 7. ส่ง response
    return res.status(200).json({
      success: true,
      message: `ภาพรวมการหยอดยาของผู้ป่วย ${totalPatients} คน`,
      data: {
        summary: {
          total_patients:  totalPatients,
          green_count:     groupedData.good.count,
          red_count:       groupedData.needs_attention.count,
          no_data_count:   groupedData.no_data.count,
        },
        groups: [
          groupedData.good,
          groupedData.needs_attention,
          groupedData.no_data
        ],
      }
    });
    
  } catch (error) {
    console.error('❌ Get Compliance Overview Error:', error);
    
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      return res.status(503).json({
        success: false,
        message: 'การเชื่อมต่อฐานข้อมูลขาดหาย',
        error: 'DATABASE_CONNECTION_LOST'
      });
    }
    
    return res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการสร้างรายงาน',
      error: process.env.NODE_ENV === 'development' ? error.message : 'INTERNAL_SERVER_ERROR'
    });
    
  } finally {
    if (connection) {
      connection.release();
    }
  }
};
// เพิ่มส่วนนี้ก่อน module.exports
const getComplianceReport = async (req, res) => {
  let connection;
  
  try {
    const { doctorId } = req.params;
    const tokenDoctorId = req.doctor?.doctor_id || req.user?.doctor_id;
    
    if (!doctorId || doctorId !== tokenDoctorId) {
      return res.status(403).json({
        success: false,
        message: 'ไม่มีสิทธิ์เข้าถึงข้อมูลนี้',
        error: 'UNAUTHORIZED'
      });
    }
    
    connection = await pool.getConnection();
    
    // ดึงรายชื่อผู้ป่วยทั้งหมดของแพทย์
    const [patients] = await connection.execute(
      `SELECT DISTINCT 
        p.patient_id,
        p.patient_hn,
        p.first_name,
        p.last_name,
        CONCAT(p.first_name, ' ', p.last_name) AS name
       FROM PatientProfiles p
       WHERE p.patient_id IN (
         SELECT DISTINCT patient_id FROM GlaucomaDiagnosis WHERE doctor_id = ?
         UNION
         SELECT DISTINCT patient_id FROM GlaucomaTreatmentPlans WHERE doctor_id = ?
         UNION
         SELECT DISTINCT patient_id FROM PatientVisits WHERE doctor_id = ?
       )
       ORDER BY p.first_name, p.last_name`,
      [doctorId, doctorId, doctorId]
    );
    
    if (patients.length === 0) {
      connection.release();
      return res.status(200).json({
        success: true,
        message: 'ไม่มีผู้ป่วย',
        data: {
          date_range: {
            start_date: new Date().toISOString().split('T')[0],
            end_date: new Date().toISOString().split('T')[0],
            days: 30
          },
          summary: {
            total_patients: 0
          },
          patients: []
        }
      });
    }
    
    // คำนวณ compliance rate (30 วันล่าสุด)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - 30);
    
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];
    
    const patientsWithCompliance = [];
    
    for (const patient of patients) {
      // นับจำนวน scheduled doses
      const [scheduledResult] = await connection.execute(
        `SELECT COUNT(DISTINCT DATE(mr.reminder_time)) as total_days
         FROM MedicationReminders mr
         WHERE mr.patient_id = ?
           AND mr.is_active = 1
           AND mr.start_date <= ?
           AND mr.end_date >= ?`,
        [patient.patient_id, endDateStr, startDateStr]
      );
      
      const totalScheduled = scheduledResult[0]?.total_days || 0;
      
      // นับจำนวน taken doses
      const [takenResult] = await connection.execute(
        `SELECT COUNT(*) as taken_count
         FROM MedicationUsageRecords
         WHERE patient_id = ?
           AND status = 'taken'
           AND DATE(scheduled_time) >= ?
           AND DATE(scheduled_time) <= ?`,
        [patient.patient_id, startDateStr, endDateStr]
      );
      
      const takenCount = takenResult[0]?.taken_count || 0;
      
      // คำนวณ compliance rate
      let complianceRate = null;
      if (totalScheduled > 0) {
        complianceRate = Math.round((takenCount / totalScheduled) * 100);
      }
      
      patientsWithCompliance.push({
        patient_id: patient.patient_id,
        patient_hn: patient.patient_hn,
        name: patient.name,
        compliance_rate: complianceRate,
        total_scheduled: totalScheduled,
        taken_count: takenCount
      });
    }
    
    connection.release();
    
    return res.status(200).json({
      success: true,
      message: 'ดึงรายงาน Compliance สำเร็จ',
      data: {
        date_range: {
          start_date: startDateStr,
          end_date: endDateStr,
          days: 30
        },
        summary: {
          total_patients: patients.length
        },
        patients: patientsWithCompliance
      }
    });
    
  } catch (error) {
    if (connection) connection.release();
    console.error('❌ Error getComplianceReport:', error);
    return res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการดึงรายงาน Compliance',
      error: process.env.NODE_ENV === 'development' ? error.message : 'INTERNAL_SERVER_ERROR'
    });
  }
};

/**
 * ผู้ป่วยกลุ่มเสี่ยง: IOP สูงเกิน Target (ใช้ค่า IOP "ล่าสุด" ต่อคน)
 * GET /api/reports/doctor/:doctorId/high-iop-risk?limit=3
 */
const getHighIOPRisk = async (req, res) => {
  let connection;

  try {
    const { doctorId } = req.params;

    // ✅ limit ต้องเป็น number 1..50
    const rawLimit = parseInt(req.query.limit ?? '3', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 3;

    const tokenDoctorId = req.doctor?.doctor_id || req.user?.doctor_id;
    if (!tokenDoctorId) {
      return res.status(401).json({ success: false, message: 'ไม่พบข้อมูลแพทย์จาก token' });
    }
    if (doctorId !== tokenDoctorId) {
      return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์เข้าถึงข้อมูลนี้' });
    }

    connection = await pool.getConnection();

    // ✅ เอาคนไข้จาก IOP_Measurements ที่หมอคนนี้เป็นคนบันทึก (ตรงกับ data ของคุณ)
    const [rows] = await connection.execute(
      `
      SELECT
        m.patient_id,
        CONCAT(p.first_name, ' ', p.last_name) AS name,
        m.measurement_date,
        m.measurement_time,
        m.left_eye_iop,
        m.right_eye_iop,
        COALESCE(gtp.target_iop_left, 21)  AS target_left,
        COALESCE(gtp.target_iop_right, 21) AS target_right,
        GREATEST(COALESCE(m.left_eye_iop, 0), COALESCE(m.right_eye_iop, 0)) AS max_iop
      FROM IOP_Measurements m
      JOIN PatientProfiles p ON p.patient_id = m.patient_id
      LEFT JOIN GlaucomaTreatmentPlans gtp
        ON gtp.patient_id = m.patient_id
       AND gtp.doctor_id = ?
      WHERE m.recorded_by = ?
        AND CONCAT(m.measurement_date, ' ', m.measurement_time) = (
          SELECT MAX(CONCAT(m2.measurement_date, ' ', m2.measurement_time))
          FROM IOP_Measurements m2
          WHERE m2.patient_id = m.patient_id
            AND m2.recorded_by = ?
        )
        AND (
          COALESCE(m.left_eye_iop, 0)  > COALESCE(gtp.target_iop_left, 21)
          OR
          COALESCE(m.right_eye_iop, 0) > COALESCE(gtp.target_iop_right, 21)
        )
      ORDER BY max_iop DESC, m.measurement_date DESC, m.measurement_time DESC
      LIMIT ${limit}
      `,
      [doctorId, doctorId, doctorId]
    );

    return res.status(200).json({
      success: true,
      message: 'ดึงรายชื่อผู้ป่วย IOP สูงเกิน Target สำเร็จ',
      data: {
        count: rows.length,
        patients: rows.map(r => ({
          patient_id: r.patient_id,
          name: r.name,
          measurement_date: r.measurement_date,
          measurement_time: r.measurement_time,
          left_eye_iop: r.left_eye_iop,
          right_eye_iop: r.right_eye_iop,
          max_iop: r.max_iop,
          target_left: r.target_left,
          target_right: r.target_right
        }))
      }
    });

  } catch (error) {
    console.error('❌ getHighIOPRisk error:', error);
    return res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการดึง High IOP Risk',
      error: process.env.NODE_ENV === 'development' ? error.message : 'INTERNAL_SERVER_ERROR'
    });
  } finally {
    if (connection) connection.release();
  }
};

// GET /api/reports/doctor/:doctorId/missed-today
const getMissedToday = async (req, res) => {
  let connection;

  try {
    const { doctorId } = req.params;

    // ✅ auth check ให้เหมือน endpoint อื่น
    const tokenDoctorId = req.doctor?.doctor_id || req.user?.doctor_id;
    if (!tokenDoctorId) {
      return res.status(401).json({
        success: false,
        message: 'ไม่พบข้อมูลแพทย์จาก token',
        error: 'NO_TOKEN_DOCTOR'
      });
    }
    if (doctorId !== tokenDoctorId) {
      return res.status(403).json({
        success: false,
        message: 'คุณไม่มีสิทธิ์เข้าถึงข้อมูลนี้',
        error: 'UNAUTHORIZED_ACCESS'
      });
    }

    connection = await pool.getConnection();

    /**
     * ✅ logic:
     * - ดู usage ที่ scheduled วันนี้ และ scheduled_time <= ตอนนี้
     * - status != 'taken' ถือว่า missed/ยังไม่หยอด
     * - กรอง patient ของหมอจาก PatientMedications (pm.doctor_id)
     * - join PatientProfiles เพื่อชื่อ
     */
    const [rows] = await connection.execute(
      `
      SELECT
        mur.patient_id,
        CONCAT(pp.first_name, ' ', pp.last_name) AS name,
        COUNT(*) AS missed_count,
        GROUP_CONCAT(
          DATE_FORMAT(mur.scheduled_time, '%H:%i')
          ORDER BY mur.scheduled_time
          SEPARATOR ', '
        ) AS missed_times
      FROM MedicationUsageRecords mur
      JOIN PatientMedications pm
        ON pm.patient_id = mur.patient_id
       AND pm.medication_id = mur.medication_id
       AND pm.doctor_id = ?
      JOIN PatientProfiles pp
        ON pp.patient_id = mur.patient_id
      WHERE DATE(mur.scheduled_time) = CURDATE()
        AND mur.scheduled_time <= NOW()
        AND (mur.status IS NULL OR mur.status <> 'taken')
      GROUP BY mur.patient_id, pp.first_name, pp.last_name
      ORDER BY missed_count DESC
      LIMIT 10
      `,
      [doctorId]
    );

    return res.status(200).json({
      success: true,
      message: 'ดึงรายการผู้ป่วยที่ยังไม่หยอดยาตามเวลา (วันนี้) สำเร็จ',
      data: {
        count: rows.length,
        patient_list: rows
      }
    });
  } catch (error) {
    console.error('❌ getMissedToday error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch missed medication today',
      error: process.env.NODE_ENV === 'development' ? error.message : 'INTERNAL_SERVER_ERROR'
    });
  } finally {
    if (connection) connection.release();
  }
};


module.exports = {
  getMonthlySummary,
  getComplianceOverview,
  getComplianceReport,
  getHighIOPRisk,
  getMissedToday
};
