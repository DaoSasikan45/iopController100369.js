// controllers/iopController.js
const pool = require('../config/database');

const getDoctorId = (req) => req.user?.doctor_id || req.doctor?.doctor_id;

const recordIOP = async (req, res) => {
  try {
    const {
      patient_id,
      left_eye_iop,
      right_eye_iop,
      measurement_device,
      measurement_method,
      notes
    } = req.body;

    const doctorId = getDoctorId(req);
    if (!doctorId) {
      return res.status(401).json({
        success: false,
        message: 'ไม่ได้รับข้อมูลผู้ใช้จาก token กรุณาเข้าสู่ระบบใหม่',
        error: 'NO_AUTH_USER'
      });
    }

    // 1) Validate patient_id
    if (!patient_id || typeof patient_id !== 'string' || patient_id.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'patient_id ต้องไม่เป็นค่าว่าง',
        error: 'INVALID_PATIENT_ID'
      });
    }

    // 2) ต้องมีอย่างน้อย 1 ค่า IOP
    if (left_eye_iop === undefined && right_eye_iop === undefined) {
      return res.status(400).json({
        success: false,
        message: 'ต้องระบุค่า IOP อย่างน้อย 1 ตา',
        error: 'NO_IOP_VALUE'
      });
    }

    // 3) Validate left
    if (left_eye_iop !== undefined) {
      const v = parseFloat(left_eye_iop);
      if (Number.isNaN(v) || v < 5 || v > 60) {
        return res.status(400).json({
          success: false,
          message: 'left_eye_iop ต้องเป็นตัวเลข 5-60 mmHg',
          error: 'INVALID_LEFT_IOP'
        });
      }
    }

    // 4) Validate right
    if (right_eye_iop !== undefined) {
      const v = parseFloat(right_eye_iop);
      if (Number.isNaN(v) || v < 5 || v > 60) {
        return res.status(400).json({
          success: false,
          message: 'right_eye_iop ต้องเป็นตัวเลข 5-60 mmHg',
          error: 'INVALID_RIGHT_IOP'
        });
      }
    }

    // 5) notes
    if (notes && notes.length > 500) {
      return res.status(400).json({
        success: false,
        message: 'notes ต้องไม่เกิน 500 ตัวอักษร',
        error: 'NOTES_TOO_LONG'
      });
    }

    // 6) ตรวจสอบผู้ป่วยมีจริง
    const [patients] = await pool.execute(
      'SELECT patient_id, first_name, last_name FROM PatientProfiles WHERE patient_id = ?',
      [patient_id]
    );

    if (patients.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'ไม่พบข้อมูลผู้ป่วย',
        error: 'PATIENT_NOT_FOUND'
      });
    }

    // ✅ 7) Target IOP (แก้ param ให้ถูก: ส่ง 1 ค่า)
    const [targetIOP] = await pool.execute(
      `SELECT target_iop_left, target_iop_right
       FROM GlaucomaTreatmentPlans
       WHERE patient_id = ? AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 1`,
      [patient_id]
    );

    const target = targetIOP.length > 0 ? targetIOP[0] : null;
    const targetLeftMax = target?.target_iop_left;
    const targetRightMax = target?.target_iop_right;

    // 8) สร้าง measurement_id
    const measurementId = `IOP${Date.now()}${Math.floor(Math.random() * 10000)}`;

    // 9) INSERT IOP record
    await pool.execute(
      `INSERT INTO IOP_Measurements (
        measurement_id,
        patient_id,
        recorded_by,
        measurement_date,
        measurement_time,
        left_eye_iop,
        right_eye_iop,
        measurement_device,
        measurement_method,
        notes
      ) VALUES (?, ?, ?, CURDATE(), CURTIME(), ?, ?, ?, ?, ?)`,
      [
        measurementId,
        patient_id,
        doctorId,
        left_eye_iop !== undefined ? parseFloat(left_eye_iop) : null,
        right_eye_iop !== undefined ? parseFloat(right_eye_iop) : null,
        measurement_device || null,
        measurement_method || null,
        notes || null
      ]
    );

    // 10) Alert ถ้าเกิน target
    const alerts = [];

    if (targetLeftMax && left_eye_iop !== undefined && parseFloat(left_eye_iop) > targetLeftMax) {
      const notifId = `NOTIF${Math.floor(Date.now() / 1000)}${Math.floor(Math.random() * 10000)
        .toString()
        .padStart(4, '0')}`;

      await pool.execute(
        `INSERT INTO Notifications (
          notification_id, user_id, notification_type, title, body,
          related_entity_type, related_entity_id, priority, is_read, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          notifId,
          patient_id,
          'high_iop',
          'IOP สูงเกินกำหนด (ตาซ้าย)',
          `ค่า IOP ตาซ้าย = ${left_eye_iop} mmHg (เกิน Target IOP ${targetLeftMax} mmHg) กรุณาติดต่อโรงพยาบาล`,
          'iop_record',
          measurementId,
          'urgent',
          0,
          'pending'
        ]
      );

      alerts.push({
        eye: 'left',
        iop_value: parseFloat(left_eye_iop),
        target_max: targetLeftMax,
        difference: parseFloat(left_eye_iop) - targetLeftMax,
        notification_id: notifId
      });
    }

    if (targetRightMax && right_eye_iop !== undefined && parseFloat(right_eye_iop) > targetRightMax) {
      const notifId = `NOTIF${Math.floor(Date.now() / 1000)}${Math.floor(Math.random() * 10000)
        .toString()
        .padStart(4, '0')}`;

      await pool.execute(
        `INSERT INTO Notifications (
          notification_id, user_id, notification_type, title, body,
          related_entity_type, related_entity_id, priority, is_read, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          notifId,
          patient_id,
          'high_iop',
          'IOP สูงเกินกำหนด (ตาขวา)',
          `ค่า IOP ตาขวา = ${right_eye_iop} mmHg (เกิน Target IOP ${targetRightMax} mmHg) กรุณาติดต่อโรงพยาบาล`,
          'iop_record',
          measurementId,
          'urgent',
          0,
          'pending'
        ]
      );

      alerts.push({
        eye: 'right',
        iop_value: parseFloat(right_eye_iop),
        target_max: targetRightMax,
        difference: parseFloat(right_eye_iop) - targetRightMax,
        notification_id: notifId
      });
    }

    // 11) ดึง record ที่เพิ่งสร้าง
    const [records] = await pool.execute(
      `SELECT measurement_id, patient_id, measurement_date, measurement_time,
              left_eye_iop, right_eye_iop, measurement_device, measurement_method, notes
       FROM IOP_Measurements
       WHERE measurement_id = ?`,
      [measurementId]
    );

    const patient = patients[0];
    const record = records[0];

    const leftStatus =
      left_eye_iop !== undefined
        ? targetLeftMax && parseFloat(left_eye_iop) > targetLeftMax
          ? '🔴 สูงเกินกำหนด'
          : '🟢 ปกติ'
        : null;

    const rightStatus =
      right_eye_iop !== undefined
        ? targetRightMax && parseFloat(right_eye_iop) > targetRightMax
          ? '🔴 สูงเกินกำหนด'
          : '🟢 ปกติ'
        : null;

    return res.status(201).json({
      success: true,
      message: 'บันทึกผลการตรวจ IOP สำเร็จ',
      data: {
        patient: {
          patient_id: patient.patient_id,
          name: `${patient.first_name} ${patient.last_name}`
        },
        iop_record: {
          measurement_id: record.measurement_id,
          measurement_date: record.measurement_date,
          measurement_time: record.measurement_time,
          left_eye: { iop_value: record.left_eye_iop, status: leftStatus, target_max: targetLeftMax },
          right_eye: { iop_value: record.right_eye_iop, status: rightStatus, target_max: targetRightMax },
          measurement_device: record.measurement_device,
          measurement_method: record.measurement_method,
          notes: record.notes
        },
        alerts: alerts.length > 0 ? alerts : null
      }
    });
  } catch (error) {
    console.error('❌ Record IOP Error:', error);

    if (error.code === 'PROTOCOL_CONNECTION_LOST' || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      return res.status(503).json({
        success: false,
        message: 'การเชื่อมต่อฐานข้อมูลขาดหาย',
        error: 'DATABASE_CONNECTION_LOST'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการบันทึก IOP',
      error: process.env.NODE_ENV === 'development' ? error.message : 'INTERNAL_SERVER_ERROR'
    });
  }
};

const getIOPHistory = async (req, res) => {
  try {
    const { patientId } = req.params;
    const { limit = 50 } = req.query;

    const doctorId = getDoctorId(req);
    if (!doctorId) {
      return res.status(401).json({
        success: false,
        message: 'ไม่ได้รับข้อมูลผู้ใช้จาก token กรุณาเข้าสู่ระบบใหม่',
        error: 'NO_AUTH_USER'
      });
    }

    if (!patientId || typeof patientId !== 'string' || patientId.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'รูปแบบ patient_id ไม่ถูกต้อง',
        error: 'INVALID_PATIENT_ID'
      });
    }

    const limitInt = parseInt(limit, 10);
    if (Number.isNaN(limitInt) || limitInt <= 0 || limitInt > 500) {
      return res.status(400).json({
        success: false,
        message: 'limit ต้องเป็นตัวเลข 1-500',
        error: 'INVALID_LIMIT'
      });
    }

    const [patients] = await pool.execute(
      'SELECT patient_id, first_name, last_name FROM PatientProfiles WHERE patient_id = ?',
      [patientId]
    );

    if (patients.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'ไม่พบข้อมูลผู้ป่วย',
        error: 'PATIENT_NOT_FOUND'
      });
    }

    // ✅ target (แก้ param ถูก)
    const [targetIOP] = await pool.execute(
      `SELECT target_iop_left, target_iop_right
       FROM GlaucomaTreatmentPlans
       WHERE patient_id = ? AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 1`,
      [patientId]
    );

    const target = targetIOP.length > 0 ? targetIOP[0] : null;
    const targetLeftMax = target?.target_iop_left;
    const targetRightMax = target?.target_iop_right;

    // ✅ ใช้ LIMIT เป็น placeholder
    const [records] = await pool.execute(
      `SELECT measurement_id, measurement_date, measurement_time,
              left_eye_iop, right_eye_iop, measurement_device, measurement_method, notes
      FROM IOP_Measurements
      WHERE patient_id = ?
      ORDER BY measurement_date DESC, measurement_time DESC
      LIMIT ${limitInt}`,
      [patientId]
    );


    const patient = patients[0];

    return res.status(200).json({
      success: true,
      message: `พบประวัติการตรวจ IOP ${records.length} รายการ`,
      data: {
        patient: { patient_id: patient.patient_id, name: `${patient.first_name} ${patient.last_name}` },
        target_iop: { left_max: targetLeftMax, right_max: targetRightMax },
        total_records: records.length,
        records
      }
    });
  } catch (error) {
    console.error('❌ Get IOP History Error:', error);

    if (error.code === 'PROTOCOL_CONNECTION_LOST' || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      return res.status(503).json({
        success: false,
        message: 'การเชื่อมต่อฐานข้อมูลขาดหาย',
        error: 'DATABASE_CONNECTION_LOST'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการดึงประวัติ IOP',
      error: process.env.NODE_ENV === 'development' ? error.message : 'INTERNAL_SERVER_ERROR'
    });
  }
};

const getLatestIOP = async (req, res) => {
  try {
    const { patientId } = req.params;

    const doctorId = getDoctorId(req);
    if (!doctorId) {
      return res.status(401).json({
        success: false,
        message: 'ไม่ได้รับข้อมูลผู้ใช้จาก token กรุณาเข้าสู่ระบบใหม่',
        error: 'NO_AUTH_USER'
      });
    }

    if (!patientId || typeof patientId !== 'string' || patientId.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'รูปแบบ patient_id ไม่ถูกต้อง',
        error: 'INVALID_PATIENT_ID'
      });
    }

    const [patients] = await pool.execute(
      'SELECT patient_id, first_name, last_name FROM PatientProfiles WHERE patient_id = ?',
      [patientId]
    );

    if (patients.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'ไม่พบข้อมูลผู้ป่วย',
        error: 'PATIENT_NOT_FOUND'
      });
    }

    // ✅ target (แก้ param ถูก)
    const [targetIOP] = await pool.execute(
      `SELECT target_iop_left, target_iop_right
       FROM GlaucomaTreatmentPlans
       WHERE patient_id = ? AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 1`,
      [patientId]
    );

    const target = targetIOP.length > 0 ? targetIOP[0] : null;

    const [records] = await pool.execute(
      `SELECT measurement_id, measurement_date, measurement_time,
              left_eye_iop, right_eye_iop, measurement_device, measurement_method, notes, recorded_by
       FROM IOP_Measurements
       WHERE patient_id = ?
       ORDER BY measurement_date DESC, measurement_time DESC
       LIMIT 1`,
      [patientId]
    );

    const patient = patients[0];

    return res.status(200).json({
      success: true,
      message: 'ดึงข้อมูล IOP ล่าสุดสำเร็จ',
      data: {
        patient: { patient_id: patient.patient_id, name: `${patient.first_name} ${patient.last_name}` },
        target_iop: { left_max: target?.target_iop_left, right_max: target?.target_iop_right },
        latest_iop: records.length ? records[0] : null
      }
    });
  } catch (error) {
    console.error('❌ Get Latest IOP Error:', error);

    if (error.code === 'PROTOCOL_CONNECTION_LOST' || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      return res.status(503).json({
        success: false,
        message: 'การเชื่อมต่อฐานข้อมูลขาดหาย',
        error: 'DATABASE_CONNECTION_LOST'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการดึงข้อมูล IOP ล่าสุด',
      error: process.env.NODE_ENV === 'development' ? error.message : 'INTERNAL_SERVER_ERROR'
    });
  }
};

module.exports = {
  recordIOP,
  getIOPHistory,
  getLatestIOP
};
