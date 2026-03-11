// controllers/medicationController.js
const pool = require('../config/database');
const ENFORCE_PATIENT_OWNERSHIP = process.env.ENFORCE_PATIENT_OWNERSHIP === 'true';

/**
 * ตรวจสิทธิ์แพทย์กับผู้ป่วยแบบ "ไม่พัง schema"
 * - ถ้า PatientProfiles มี doctor_id / primary_doctor_id / created_by_doctor_id จะใช้ก่อน
 * - ถ้าไม่มีคอลัมน์เหล่านี้ จะ fallback ไปใช้ logic เดิม (3 ตาราง)
 */
async function doctorHasAccessToPatient(connection, patientId, doctorId) {
  // โหมดโปรเจกต์/เดโม่: แค่ผู้ป่วยมีอยู่จริง + หมอมี token ก็ให้ทำงานได้
  if (!ENFORCE_PATIENT_OWNERSHIP) return true;

  // 1) Try direct mapping on PatientProfiles (ถ้ามีคอลัมน์)
  try {
    const [rows] = await connection.execute(
      `SELECT 1
       FROM PatientProfiles
       WHERE patient_id = ?
         AND (
           doctor_id = ?
           OR primary_doctor_id = ?
           OR created_by_doctor_id = ?
         )
       LIMIT 1`,
      [patientId, doctorId, doctorId, doctorId]
    );
    if (rows.length > 0) return true;
  } catch (err) {
    if (err && err.code !== 'ER_BAD_FIELD_ERROR') throw err;
  }

  // 2) Fallback: logic เดิมของระบบคุณ
  const [access] = await connection.execute(
    `SELECT COUNT(*) as has_access
     FROM (
       SELECT patient_id FROM GlaucomaDiagnosis WHERE patient_id = ? AND doctor_id = ?
       UNION
       SELECT patient_id FROM GlaucomaTreatmentPlans WHERE patient_id = ? AND doctor_id = ?
       UNION
       SELECT patient_id FROM PatientVisits WHERE patient_id = ? AND doctor_id = ?
     ) AS patient_access`,
    [patientId, doctorId, patientId, doctorId, patientId, doctorId]
  );

  return Number(access?.[0]?.has_access || 0) > 0;
}

/**
 * สั่งยาให้ผู้ป่วย (รองรับหลายยาพร้อมกัน)
 * POST /api/medications
 */
const prescribeMedications = async (req, res) => {
  let connection;

  try {
    const { patient_id, medications } = req.body;

    const doctorId = req.user?.doctor_id || req.doctor?.doctor_id;
    if (!doctorId) {
      return res.status(401).json({
        success: false,
        message: 'ไม่ได้รับข้อมูลผู้ใช้จาก token กรุณาเข้าสู่ระบบใหม่',
        error: 'NO_AUTH_USER',
      });
    }

    // 1) Validate patient_id
    if (!patient_id || typeof patient_id !== 'string' || patient_id.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'รูปแบบ patient_id ไม่ถูกต้อง',
        error: 'INVALID_PATIENT_ID',
      });
    }

    // 2) Validate medications array
    if (!medications || !Array.isArray(medications) || medications.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'กรุณาระบุรายการยาอย่างน้อย 1 รายการ',
        error: 'MISSING_MEDICATIONS',
      });
    }

    // 3) Validate each medication
    const validTimeOfDay = ['morning', 'afternoon', 'evening'];
    const validEye = ['left', 'right', 'both'];

    for (let i = 0; i < medications.length; i++) {
      const med = medications[i];

      if (!med.medication_id || typeof med.medication_id !== 'string') {
        return res.status(400).json({
          success: false,
          message: `ยาลำดับที่ ${i + 1}: medication_id ไม่ถูกต้อง`,
          error: 'INVALID_MEDICATION_ID',
        });
      }

      if (!med.eye || !validEye.includes(med.eye)) {
        return res.status(400).json({
          success: false,
          message: `ยาลำดับที่ ${i + 1}: eye ต้องเป็น left, right หรือ both`,
          error: 'INVALID_EYE',
        });
      }

      if (!med.dosage || typeof med.dosage !== 'string' || med.dosage.trim() === '') {
        return res.status(400).json({
          success: false,
          message: `ยาลำดับที่ ${i + 1}: กรุณาระบุ dosage`,
          error: 'MISSING_DOSAGE',
        });
      }

      if (!med.frequency || typeof med.frequency !== 'string' || med.frequency.trim() === '') {
        return res.status(400).json({
          success: false,
          message: `ยาลำดับที่ ${i + 1}: กรุณาระบุ frequency`,
          error: 'MISSING_FREQUENCY',
        });
      }

      const duration = parseInt(med.duration_days, 10);
      if (Number.isNaN(duration) || duration <= 0) {
        return res.status(400).json({
          success: false,
          message: `ยาลำดับที่ ${i + 1}: duration_days ต้องเป็นตัวเลขมากกว่า 0`,
          error: 'INVALID_DURATION',
        });
      }

      // schedules (optional)
      if (med.schedules !== undefined) {
        if (!Array.isArray(med.schedules)) {
          return res.status(400).json({
            success: false,
            message: `ยาลำดับที่ ${i + 1}: schedules ต้องเป็น array`,
            error: 'INVALID_SCHEDULES_TYPE',
          });
        }

        for (let j = 0; j < med.schedules.length; j++) {
          const schedule = med.schedules[j];

          if (schedule.time_of_day && !validTimeOfDay.includes(schedule.time_of_day)) {
            return res.status(400).json({
              success: false,
              message: `ยาลำดับที่ ${i + 1}, เวลาแถวที่ ${j + 1}: time_of_day ต้องเป็น morning, afternoon หรือ evening`,
              error: 'INVALID_TIME_OF_DAY',
            });
          }

          const timeRegex = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
          if (!schedule.scheduled_time || !timeRegex.test(schedule.scheduled_time)) {
            return res.status(400).json({
              success: false,
              message: `ยาลำดับที่ ${i + 1}, เวลาแถวที่ ${j + 1}: scheduled_time ต้องเป็นรูปแบบ HH:MM:SS`,
              error: 'INVALID_SCHEDULED_TIME',
            });
          }
        }
      }
    }

    // 4) Get connection
    try {
      connection = await pool.getConnection();
    } catch (connError) {
      console.error('❌ Database Connection Error:', connError);
      return res.status(503).json({
        success: false,
        message: 'ไม่สามารถเชื่อมต่อฐานข้อมูลได้',
        error: 'DATABASE_CONNECTION_ERROR',
      });
    }

    // 5) Check patient exists
    const [patients] = await connection.execute(
      'SELECT patient_id, first_name, last_name FROM PatientProfiles WHERE patient_id = ?',
      [patient_id]
    );

    if (patients.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'ไม่พบข้อมูลผู้ป่วย',
        error: 'PATIENT_NOT_FOUND',
      });
    }

    // 6) Check access (FIX 403)
    const ok = await doctorHasAccessToPatient(connection, patient_id, doctorId);
    if (!ok) {
      return res.status(403).json({
        success: false,
        message: 'คุณไม่มีสิทธิ์สั่งยาให้ผู้ป่วยคนนี้',
        error: 'UNAUTHORIZED_ACCESS',
      });
    }

    // 7) Transaction
    await connection.beginTransaction();

    try {
      const prescribedMedications = [];

      for (const med of medications) {
        // 7.1 Validate medication exists
        const [medicationExists] = await connection.execute(
          'SELECT medication_id, name, generic_name, category FROM Medications WHERE medication_id = ?',
          [med.medication_id]
        );

        if (medicationExists.length === 0) {
          await connection.rollback();
          return res.status(404).json({
            success: false,
            message: `ไม่พบยา medication_id: ${med.medication_id}`,
            error: 'MEDICATION_NOT_FOUND',
          });
        }

        const medicationInfo = medicationExists[0];

        // 7.2 Generate IDs
        const prescriptionId = `PRES${Date.now()}${Math.floor(Math.random() * 1000)}`;

        // 7.3 Dates
        const startDate = new Date();
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + parseInt(med.duration_days, 10));

        // 7.4 Insert PatientMedications
        await connection.execute(
          `INSERT INTO PatientMedications (
            prescription_id,
            patient_id,
            doctor_id,
            medication_id,
            eye,
            dosage,
            frequency,
            duration,
            status,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW())`,
          [
            prescriptionId,
            patient_id,
            doctorId,
            med.medication_id,
            med.eye,
            med.dosage,
            med.frequency,
            `${med.duration_days} days`,
          ]
        );

        // 7.5 Insert reminders (if schedules provided)
        const reminders = [];
        if (Array.isArray(med.schedules) && med.schedules.length > 0) {
          for (const schedule of med.schedules) {
            const reminderId = `REM${Date.now()}${Math.floor(Math.random() * 10000)}`;
            const daysOfWeek = schedule.days_of_week || '1,2,3,4,5,6,7';

            await connection.execute(
              `INSERT INTO MedicationReminders (
                reminder_id,
                patient_id,
                prescription_id,
                medication_id,
                reminder_time,
                days_of_week,
                start_date,
                end_date,
                eye,
                drops_count,
                is_active,
                created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())`,
              [
                reminderId,
                patient_id,
                prescriptionId,
                med.medication_id,
                schedule.scheduled_time,
                daysOfWeek,
                startDate.toISOString().split('T')[0],
                endDate.toISOString().split('T')[0],
                med.eye,
                med.drops_count || 1,
              ]
            );

            reminders.push({
              reminder_id: reminderId,
              time_of_day: schedule.time_of_day,
              scheduled_time: schedule.scheduled_time,
              days_of_week: daysOfWeek,
            });
          }
        }

        prescribedMedications.push({
          prescription_id: prescriptionId,
          medication: {
            medication_id: med.medication_id,
            name: medicationInfo.name,
            generic_name: medicationInfo.generic_name,
            category: medicationInfo.category,
          },
          eye: med.eye,
          dosage: med.dosage,
          frequency: med.frequency,
          duration: `${med.duration_days} days`,
          start_date: startDate.toISOString().split('T')[0],
          end_date: endDate.toISOString().split('T')[0],
          status: 'active',
          reminders,
        });
      }

      await connection.commit();

      const patient = patients[0];
      return res.status(201).json({
        success: true,
        message: `สั่งยาสำเร็จ (${prescribedMedications.length} รายการ)`,
        data: {
          patient: {
            patient_id: patient.patient_id,
            name: `${patient.first_name} ${patient.last_name}`,
          },
          prescriptions: prescribedMedications,
          total_medications: prescribedMedications.length,
        },
      });
    } catch (txError) {
      await connection.rollback();
      throw txError;
    }
  } catch (error) {
    console.error('❌ Prescribe Medications Error:', error);

    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      return res.status(503).json({
        success: false,
        message: 'การเชื่อมต่อฐานข้อมูลขาดหาย',
        error: 'DATABASE_CONNECTION_LOST',
      });
    }

    if (error.code && error.code.startsWith('ER_')) {
      return res.status(500).json({
        success: false,
        message: 'เกิดข้อผิดพลาดในการบันทึกข้อมูล',
        error: 'DATABASE_ERROR',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }

    return res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการสั่งยา',
      error: process.env.NODE_ENV === 'development' ? error.message : 'INTERNAL_SERVER_ERROR',
    });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * ดูยาทั้งหมดของผู้ป่วย
 * GET /api/patients/:patientId/medications
 */
const getPatientMedications = async (req, res) => {
  let connection;

  try {
    const { patientId } = req.params;
    const { status = 'all' } = req.query;

    const doctorId = req.user?.doctor_id || req.doctor?.doctor_id;
    if (!doctorId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized - No doctor ID found',
        error: 'UNAUTHORIZED',
      });
    }

    if (!patientId || typeof patientId !== 'string' || patientId.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'รูปแบบ patient_id ไม่ถูกต้อง',
        error: 'INVALID_PATIENT_ID',
      });
    }

    const validStatus = ['all', 'active', 'completed', 'discontinued'];
    if (!validStatus.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'status ต้องเป็น all, active, completed หรือ discontinued',
        error: 'INVALID_STATUS',
      });
    }

    connection = await pool.getConnection();

    const [patients] = await connection.execute(
      'SELECT patient_id, first_name, last_name FROM PatientProfiles WHERE patient_id = ?',
      [patientId]
    );

    if (patients.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'ไม่พบข้อมูลผู้ป่วย',
        error: 'PATIENT_NOT_FOUND',
      });
    }

    const ok = await doctorHasAccessToPatient(connection, patientId, doctorId);
    if (!ok) {
      return res.status(403).json({
        success: false,
        message: 'คุณไม่มีสิทธิ์เข้าถึงข้อมูลผู้ป่วยคนนี้',
        error: 'UNAUTHORIZED_ACCESS',
      });
    }

    let statusCondition = '';
    const params = [patientId];
    if (status !== 'all') {
      statusCondition = 'AND pm.status = ?';
      params.push(status);
    }

    const [prescriptions] = await connection.execute(
      `SELECT 
        pm.prescription_id,
        pm.medication_id,
        pm.eye,
        pm.dosage,
        pm.frequency,
        pm.duration,
        pm.quantity_dispensed,
        pm.refills,
        pm.special_instructions,
        pm.status,
        pm.discontinued_reason,
        pm.last_dispensed_date,
        pm.created_at,
        pm.updated_at,
        m.name AS medication_name,
        m.generic_name,
        m.category,
        m.form,
        m.strength,
        m.description AS medication_description,
        d.first_name AS doctor_first_name,
        d.last_name AS doctor_last_name
       FROM PatientMedications pm
       INNER JOIN Medications m ON pm.medication_id = m.medication_id
       INNER JOIN DoctorProfiles d ON pm.doctor_id = d.doctor_id
       WHERE pm.patient_id = ? ${statusCondition}
       ORDER BY pm.created_at DESC`,
      params
    );

    if (prescriptions.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'ไม่มียาที่สั่งไว้',
        data: {
          patient: {
            patient_id: patients[0].patient_id,
            name: `${patients[0].first_name} ${patients[0].last_name}`,
          },
          total_medications: 0,
          active_medications: 0,
          discontinued_medications: 0,
          completed_medications: 0,
          medications: [],
        },
      });
    }

    const prescriptionIds = prescriptions.map((p) => p.prescription_id);

    const [reminders] = await connection.execute(
      `SELECT 
        reminder_id,
        prescription_id,
        medication_id,
        reminder_time,
        days_of_week,
        start_date,
        end_date,
        eye,
        drops_count,
        is_active,
        notification_channels
       FROM MedicationReminders
       WHERE prescription_id IN (${prescriptionIds.map(() => '?').join(',')})
       ORDER BY reminder_time ASC`,
      prescriptionIds
    );

    const remindersByPrescription = {};
    reminders.forEach((r) => {
      if (!remindersByPrescription[r.prescription_id]) remindersByPrescription[r.prescription_id] = [];

      const daysOfWeek = r.days_of_week ? r.days_of_week.split(',') : [];
      const dayNames = {
        '1': 'จันทร์',
        '2': 'อังคาร',
        '3': 'พุธ',
        '4': 'พฤหัสบดี',
        '5': 'ศุกร์',
        '6': 'เสาร์',
        '7': 'อาทิตย์',
      };

      remindersByPrescription[r.prescription_id].push({
        reminder_id: r.reminder_id,
        reminder_time: r.reminder_time,
        days_of_week: daysOfWeek,
        days_of_week_text: daysOfWeek.map((d) => dayNames[d]).join(', '),
        start_date: r.start_date,
        end_date: r.end_date,
        eye: r.eye,
        drops_count: r.drops_count,
        is_active: r.is_active === 1,
        notification_channels: r.notification_channels,
      });
    });

    const medications = prescriptions.map((p) => ({
      prescription_id: p.prescription_id,
      medication: {
        medication_id: p.medication_id,
        name: p.medication_name,
        generic_name: p.generic_name,
        category: p.category,
        form: p.form,
        strength: p.strength,
        description: p.medication_description,
      },
      prescribed_by: {
        name: `${p.doctor_first_name} ${p.doctor_last_name}`,
      },
      eye: p.eye,
      dosage: p.dosage,
      frequency: p.frequency,
      duration: p.duration,
      quantity_dispensed: p.quantity_dispensed,
      refills: p.refills,
      special_instructions: p.special_instructions,
      status: p.status,
      discontinued_reason: p.discontinued_reason,
      last_dispensed_date: p.last_dispensed_date,
      prescribed_date: p.created_at,
      updated_at: p.updated_at,
      reminders: remindersByPrescription[p.prescription_id] || [],
      total_reminders: (remindersByPrescription[p.prescription_id] || []).length,
      active_reminders: (remindersByPrescription[p.prescription_id] || []).filter((x) => x.is_active).length,
    }));

    const statusCounts = medications.reduce((acc, med) => {
      acc[med.status] = (acc[med.status] || 0) + 1;
      return acc;
    }, {});

    const activeMedications = medications.filter((m) => m.status === 'active');
    const discontinuedMedications = medications.filter((m) => m.status === 'discontinued');
    const completedMedications = medications.filter((m) => m.status === 'completed');

    return res.status(200).json({
      success: true,
      message: `พบยาทั้งหมด ${medications.length} รายการ`,
      data: {
        patient: {
          patient_id: patients[0].patient_id,
          name: `${patients[0].first_name} ${patients[0].last_name}`,
        },
        filter: { status },
        summary: {
          total_medications: medications.length,
          active_medications: statusCounts.active || 0,
          discontinued_medications: statusCounts.discontinued || 0,
          completed_medications: statusCounts.completed || 0,
        },
        medications:
          status === 'all'
            ? { active: activeMedications, discontinued: discontinuedMedications, completed: completedMedications }
            : medications,
      },
    });
  } catch (error) {
    console.error('❌ Get Patient Medications Error:', error);

    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      return res.status(503).json({
        success: false,
        message: 'การเชื่อมต่อฐานข้อมูลขาดหาย',
        error: 'DATABASE_CONNECTION_LOST',
      });
    }

    if (error.code && error.code.startsWith('ER_')) {
      return res.status(500).json({
        success: false,
        message: 'เกิดข้อผิดพลาดในการดึงข้อมูล',
        error: 'DATABASE_ERROR',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }

    return res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการดึงข้อมูลยา',
      error: process.env.NODE_ENV === 'development' ? error.message : 'INTERNAL_SERVER_ERROR',
    });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * อัปเดตข้อมูลยา หรือหยุดยา
 * PUT /api/medications/:prescriptionId
 */
const updatePrescription = async (req, res) => {
  let connection;

  try {
    const { prescriptionId } = req.params;
    const { action, discontinued_reason, dosage, frequency, duration_days } = req.body;

    const doctorId = req.user?.doctor_id || req.doctor?.doctor_id;
    if (!doctorId) {
      return res.status(401).json({
        success: false,
        message: 'ไม่ได้รับข้อมูลผู้ใช้จาก token กรุณาเข้าสู่ระบบใหม่',
        error: 'NO_AUTH_USER',
      });
    }

    if (!prescriptionId || typeof prescriptionId !== 'string' || prescriptionId.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'รูปแบบ prescription_id ไม่ถูกต้อง',
        error: 'INVALID_PRESCRIPTION_ID',
      });
    }

    if (!action || !['stop', 'update'].includes(action)) {
      return res.status(400).json({
        success: false,
        message: 'action ต้องเป็น stop หรือ update',
        error: 'INVALID_ACTION',
      });
    }

    if (action === 'stop') {
      if (!discontinued_reason || typeof discontinued_reason !== 'string' || discontinued_reason.trim() === '') {
        return res.status(400).json({
          success: false,
          message: 'กรุณาระบุเหตุผลในการหยุดยา',
          error: 'MISSING_DISCONTINUED_REASON',
        });
      }
    }

    if (action === 'update') {
      if (!dosage && !frequency && duration_days === undefined) {
        return res.status(400).json({
          success: false,
          message: 'กรุณาระบุข้อมูลที่ต้องการแก้ไขอย่างน้อย 1 รายการ',
          error: 'NO_UPDATE_FIELDS',
        });
      }

      if (duration_days !== undefined) {
        const duration = parseInt(duration_days, 10);
        if (Number.isNaN(duration) || duration <= 0) {
          return res.status(400).json({
            success: false,
            message: 'duration_days ต้องเป็นตัวเลขมากกว่า 0',
            error: 'INVALID_DURATION',
          });
        }
      }
    }

    connection = await pool.getConnection();

    const [prescriptions] = await connection.execute(
      `SELECT 
        pm.prescription_id,
        pm.patient_id,
        pm.doctor_id,
        pm.medication_id,
        pm.status,
        m.name AS medication_name,
        p.first_name,
        p.last_name
       FROM PatientMedications pm
       INNER JOIN Medications m ON pm.medication_id = m.medication_id
       INNER JOIN PatientProfiles p ON pm.patient_id = p.patient_id
       WHERE pm.prescription_id = ?`,
      [prescriptionId]
    );

    if (prescriptions.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'ไม่พบข้อมูลยา',
        error: 'PRESCRIPTION_NOT_FOUND',
      });
    }

    const prescription = prescriptions[0];

    const ok = await doctorHasAccessToPatient(connection, prescription.patient_id, doctorId);
    if (!ok) {
      return res.status(403).json({
        success: false,
        message: 'คุณไม่มีสิทธิ์แก้ไขยานี้',
        error: 'UNAUTHORIZED_ACCESS',
      });
    }

    if (action === 'stop' && prescription.status === 'discontinued') {
      return res.status(400).json({
        success: false,
        message: 'ยานี้ถูกหยุดใช้แล้ว',
        error: 'ALREADY_STOPPED',
      });
    }

    await connection.beginTransaction();

    try {
      if (action === 'stop') {
        await connection.execute(
          `UPDATE PatientMedications 
           SET status = 'discontinued',
               discontinued_reason = ?,
               updated_at = NOW()
           WHERE prescription_id = ?`,
          [discontinued_reason, prescriptionId]
        );

        await connection.execute(
          `UPDATE MedicationReminders 
           SET is_active = 0,
               updated_at = NOW()
           WHERE prescription_id = ?`,
          [prescriptionId]
        );
      } else {
        const updateFields = [];
        const updateValues = [];

        if (dosage) {
          updateFields.push('dosage = ?');
          updateValues.push(dosage);
        }

        if (frequency) {
          updateFields.push('frequency = ?');
          updateValues.push(frequency);
        }

        if (duration_days !== undefined) {
          updateFields.push('duration = ?');
          updateValues.push(`${duration_days} days`);
        }

        if (updateFields.length > 0) {
          updateFields.push('updated_at = NOW()');
          updateValues.push(prescriptionId);

          await connection.execute(
            `UPDATE PatientMedications 
             SET ${updateFields.join(', ')}
             WHERE prescription_id = ?`,
            updateValues
          );
        }
      }

      await connection.commit();

      const [updatedPrescription] = await connection.execute(
        `SELECT 
          pm.*,
          m.name AS medication_name,
          m.generic_name,
          m.category
         FROM PatientMedications pm
         INNER JOIN Medications m ON pm.medication_id = m.medication_id
         WHERE pm.prescription_id = ?`,
        [prescriptionId]
      );

      return res.status(200).json({
        success: true,
        message: action === 'stop' ? 'หยุดยาสำเร็จ' : 'แก้ไขข้อมูลยาสำเร็จ',
        data: {
          patient: {
            patient_id: prescription.patient_id,
            name: `${prescription.first_name} ${prescription.last_name}`,
          },
          medication: {
            medication_id: prescription.medication_id,
            name: prescription.medication_name,
          },
          prescription: updatedPrescription[0],
          action,
        },
      });
    } catch (txError) {
      await connection.rollback();
      throw txError;
    }
  } catch (error) {
    console.error('❌ Update Prescription Error:', error);

    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      return res.status(503).json({
        success: false,
        message: 'การเชื่อมต่อฐานข้อมูลขาดหาย',
        error: 'DATABASE_CONNECTION_LOST',
      });
    }

    return res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการอัปเดตยา',
      error: process.env.NODE_ENV === 'development' ? error.message : 'INTERNAL_SERVER_ERROR',
    });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * แก้ไขเวลาหยอดยา
 * PUT /api/medication-reminders/:reminderId
 */
const updateMedicationReminder = async (req, res) => {
  let connection;

  try {
    const { reminderId } = req.params;
    const { reminder_time, days_of_week } = req.body;

    const doctorId = req.user?.doctor_id || req.doctor?.doctor_id;
    if (!doctorId) {
      return res.status(401).json({
        success: false,
        message: 'ไม่ได้รับข้อมูลผู้ใช้จาก token กรุณาเข้าสู่ระบบใหม่',
        error: 'NO_AUTH_USER',
      });
    }

    if (!reminderId || typeof reminderId !== 'string' || reminderId.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'รูปแบบ reminder_id ไม่ถูกต้อง',
        error: 'INVALID_REMINDER_ID',
      });
    }

    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
    if (!reminder_time || !timeRegex.test(reminder_time)) {
      return res.status(400).json({
        success: false,
        message: 'reminder_time ต้องเป็นรูปแบบ HH:MM:SS (เช่น 08:00:00)',
        error: 'INVALID_TIME_FORMAT',
      });
    }

    if (days_of_week) {
      const daysArray = days_of_week.split(',');
      const validDays = ['1', '2', '3', '4', '5', '6', '7'];
      for (const day of daysArray) {
        if (!validDays.includes(day.trim())) {
          return res.status(400).json({
            success: false,
            message: 'days_of_week ต้องเป็นตัวเลข 1-7 คั่นด้วย comma (เช่น 1,2,3,4,5,6,7)',
            error: 'INVALID_DAYS_OF_WEEK',
          });
        }
      }
    }

    connection = await pool.getConnection();

    const [reminders] = await connection.execute(
      `SELECT 
        mr.reminder_id,
        mr.patient_id,
        mr.prescription_id,
        mr.medication_id,
        mr.reminder_time,
        mr.days_of_week,
        mr.is_active,
        pm.doctor_id,
        m.name AS medication_name,
        p.first_name,
        p.last_name
       FROM MedicationReminders mr
       INNER JOIN PatientMedications pm ON mr.prescription_id = pm.prescription_id
       INNER JOIN Medications m ON mr.medication_id = m.medication_id
       INNER JOIN PatientProfiles p ON mr.patient_id = p.patient_id
       WHERE mr.reminder_id = ?`,
      [reminderId]
    );

    if (reminders.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'ไม่พบข้อมูลการแจ้งเตือน',
        error: 'REMINDER_NOT_FOUND',
      });
    }

    const reminder = reminders[0];

    const ok = await doctorHasAccessToPatient(connection, reminder.patient_id, doctorId);
    if (!ok) {
      return res.status(403).json({
        success: false,
        message: 'คุณไม่มีสิทธิ์แก้ไขการแจ้งเตือนนี้',
        error: 'UNAUTHORIZED_ACCESS',
      });
    }

    const updateFields = ['reminder_time = ?', 'updated_at = NOW()'];
    const updateValues = [reminder_time];

    if (days_of_week) {
      updateFields.push('days_of_week = ?');
      updateValues.push(days_of_week);
    }

    updateValues.push(reminderId);

    await connection.execute(
      `UPDATE MedicationReminders 
       SET ${updateFields.join(', ')}
       WHERE reminder_id = ?`,
      updateValues
    );

    const [updatedReminder] = await connection.execute(
      `SELECT * FROM MedicationReminders WHERE reminder_id = ?`,
      [reminderId]
    );

    return res.status(200).json({
      success: true,
      message: 'แก้ไขเวลาหยอดยาสำเร็จ',
      data: {
        patient: {
          patient_id: reminder.patient_id,
          name: `${reminder.first_name} ${reminder.last_name}`,
        },
        medication: {
          medication_id: reminder.medication_id,
          name: reminder.medication_name,
        },
        reminder: {
          ...updatedReminder[0],
          old_time: reminder.reminder_time,
          new_time: reminder_time,
        },
      },
    });
  } catch (error) {
    console.error('❌ Update Medication Reminder Error:', error);

    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      return res.status(503).json({
        success: false,
        message: 'การเชื่อมต่อฐานข้อมูลขาดหาย',
        error: 'DATABASE_CONNECTION_LOST',
      });
    }

    return res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการแก้ไขเวลาหยอดยา',
      error: process.env.NODE_ENV === 'development' ? error.message : 'INTERNAL_SERVER_ERROR',
    });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * ดึงรายการยาทั้งหมด
 * GET /api/medications
 */
const getAllMedications = async (req, res) => {
  try {
    const [medications] = await pool.query(
      `SELECT 
        medication_id,
        name,
        generic_name,
        category
       FROM Medications
       ORDER BY name ASC`
    );

    return res.json({
      success: true,
      data: { medications },
    });
  } catch (error) {
    console.error('Error fetching medications:', error);
    return res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการดึงข้อมูลยา',
      error: process.env.NODE_ENV === 'development' ? error.message : 'INTERNAL_SERVER_ERROR',
    });
  }
};

module.exports = {
  prescribeMedications,
  getPatientMedications,
  updatePrescription,
  updateMedicationReminder,
  getAllMedications,
};
