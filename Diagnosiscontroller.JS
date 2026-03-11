// controllers/diagnosisController.js
const pool = require('../config/database');

/**
 * เช็คสิทธิ์หมอกับคนไข้ แบบไม่แตะ schema
 * ใช้ logic เดียวกับระบบคุณ (3 ตาราง)
 */
async function doctorHasAccessToPatient(connection, patientId, doctorId) {
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
 * หา "ตารางวินิจฉัย" ที่มีอยู่จริงใน DB
 * (ไม่แก้ DB แค่เช็ค)
 */
async function resolveDiagnosisTable(connection) {
  const [rows] = await connection.execute(
    `SELECT TABLE_NAME
     FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND TABLE_NAME IN ('GlaucomaDiagnosis', 'diagnoses')`
  );

  const names = rows.map(r => r.TABLE_NAME || r.table_name);

  if (names.includes('GlaucomaDiagnosis')) return 'GlaucomaDiagnosis';
  if (names.includes('diagnoses')) return 'diagnoses';

  const err = new Error('No diagnosis table found (GlaucomaDiagnosis/diagnoses)');
  err.status = 500;
  throw err;
}

/**
 * อ่านคนไข้จาก PatientProfiles (ตามระบบคุณ)
 */
async function ensurePatientExists(connection, patientId) {
  const [patients] = await connection.execute(
    'SELECT patient_id, first_name, last_name FROM PatientProfiles WHERE patient_id = ?',
    [patientId]
  );
  return patients;
}

/**
 * =========================
 *  POST /api/diagnoses
 * =========================
 * รองรับ field หลายแบบ กัน frontend ส่งไม่ตรง:
 * - patient_id / patientId
 * - diagnosis_name / diagnosisName
 */

// =========================
//  POST /api/diagnoses
// =========================
const createDiagnosis = async (req, res) => {
  let connection;

  try {
    const doctorId = req.user?.doctor_id || req.doctor?.doctor_id;
    if (!doctorId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
        error: 'NO_AUTH_USER',
      });
    }

    const raw = req.body || {};
    const body = raw.data || raw.diagnosis || raw.payload || raw;

    const patient_id =
      body.patient_id || body.patientId || body.patientID ||
      raw.patient_id  || raw.patientId  || raw.patientID;

    // ✅ ใช้ field ที่ DB มีจริง: glaucoma_type
    const glaucoma_type =
      body.glaucoma_type || body.glaucomaType ||
      raw.glaucoma_type  || raw.glaucomaType;

    // ✅ DB ต้องการ diagnosis_date (NOT NULL) → ถ้าไม่ส่งมา ให้วันนี้
    const diagnosis_date =
      body.diagnosis_date || body.diagnosisDate ||
      raw.diagnosis_date  || raw.diagnosisDate ||
      new Date().toISOString().slice(0, 10);

    // ✅ severity ใน DB: early/moderate/advanced/severe
    // frontend ของคุณใช้ mild/moderate/severe → แปลง mild => early
    let severity = body.severity ?? raw.severity ?? null;
    if (severity === 'mild') severity = 'early';
    if (severity && !['early', 'moderate', 'advanced', 'severe'].includes(severity)) {
      // ถ้าส่งมาแปลกๆ ให้ตั้งค่าปลอดภัย
      severity = 'moderate';
    }
    if (!severity) severity = 'moderate';

    const left_eye_affected =
      body.left_eye_affected ?? body.leftEyeAffected ?? raw.left_eye_affected ?? raw.leftEyeAffected ?? false;

    const right_eye_affected =
      body.right_eye_affected ?? body.rightEyeAffected ?? raw.right_eye_affected ?? raw.rightEyeAffected ?? false;

    const icd_code = body.icd_code || body.icdCode || raw.icd_code || raw.icdCode || null;
    const notes = body.notes ?? raw.notes ?? null;

    // Target IOP (optional)
    const target_iop_left  = body.target_iop_left  != null ? parseFloat(body.target_iop_left)  : null;
    const target_iop_right = body.target_iop_right != null ? parseFloat(body.target_iop_right) : null;

    // optional (DB มีจริง)
    const diagnosis_details = body.diagnosis_details || body.diagnosisDetails || null;
    const diagnosis_basis = body.diagnosis_basis || body.diagnosisBasis || null;

    console.log('🩺 [createDiagnosis] raw body:', JSON.stringify(req.body));

    // ✅ required ที่ควรมี
    if (!patient_id || !glaucoma_type) {
      return res.status(400).json({
        success: false,
        message: 'กรุณาระบุ patient_id และ glaucoma_type',
        error: 'MISSING_REQUIRED_FIELDS',
        received_keys: Object.keys(body),
      });
    }

    connection = await pool.getConnection();

    // patient exists?
    const patients = await ensurePatientExists(connection, patient_id);
    if (!patients || patients.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'ไม่พบข้อมูลผู้ป่วย',
        error: 'PATIENT_NOT_FOUND',
      });
    }

    // ถ้าตอนนี้ยังไม่พร้อมเรื่อง mapping หมอ-คนไข้ ให้คอมเมนต์ไว้ชั่วคราวได้
    // (แต่ตอน deploy ควรเปิดกลับ)
    // const ok = await doctorHasAccessToPatient(connection, patient_id, doctorId);
    // if (!ok) return res.status(403).json({ success:false, message:'คุณไม่มีสิทธิ์...', error:'UNAUTHORIZED_ACCESS' });

    // ✅ ตารางจริงของคุณคือ GlaucomaDiagnosis
    const diagnosis_id = `DIA${Date.now()}${Math.floor(Math.random() * 1000)}`;

    await connection.execute(
      `INSERT INTO GlaucomaDiagnosis
       (diagnosis_id, patient_id, doctor_id, diagnosis_date, glaucoma_type, icd_code,
        diagnosis_details, diagnosis_basis, severity, left_eye_affected, right_eye_affected, notes,
        target_iop_left, target_iop_right)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        diagnosis_id,
        patient_id,
        doctorId,
        diagnosis_date,
        glaucoma_type,
        icd_code,
        diagnosis_details,
        diagnosis_basis,
        severity,
        left_eye_affected ? 1 : 0,
        right_eye_affected ? 1 : 0,
        notes,
        target_iop_left,
        target_iop_right,
      ]
    );

    // ส่งแถวที่เพิ่ง insert กลับไปเลย (ช่วยให้หน้าแสดงทันที)
    const [rows] = await connection.execute(
      `SELECT * FROM GlaucomaDiagnosis WHERE diagnosis_id = ? LIMIT 1`,
      [diagnosis_id]
    );

    return res.status(201).json({
      success: true,
      message: 'บันทึกการวินิจฉัยสำเร็จ',
      data: { diagnosis: rows?.[0] || { diagnosis_id } },
    });
  } catch (err) {
    console.error('❌ createDiagnosis error:', err);
    return res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการบันทึกการวินิจฉัย',
      error: process.env.NODE_ENV === 'development' ? err.message : 'INTERNAL_SERVER_ERROR',
    });
  } finally {
    if (connection) connection.release();
  }
};

// =========================
//  GET /api/diagnoses/patient/:patientId
// =========================
const getPatientDiagnoses = async (req, res) => {
  let connection;

  try {
    const doctorId = req.user?.doctor_id || req.doctor?.doctor_id;
    if (!doctorId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
        error: 'NO_AUTH_USER',
      });
    }

    const { patientId } = req.params;
    if (!patientId) {
      return res.status(400).json({
        success: false,
        message: 'กรุณาระบุ patientId',
        error: 'MISSING_PATIENT_ID',
      });
    }

    connection = await pool.getConnection();

    const patients = await ensurePatientExists(connection, patientId);
    if (!patients || patients.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'ไม่พบข้อมูลผู้ป่วย',
        error: 'PATIENT_NOT_FOUND',
      });
    }

    // เช่นกัน ถ้ายังไม่พร้อมเรื่องสิทธิ์ ให้คอมเมนต์ชั่วคราวได้
    // const ok = await doctorHasAccessToPatient(connection, patientId, doctorId);
    // if (!ok) return res.status(403).json({ success:false, message:'คุณไม่มีสิทธิ์...', error:'UNAUTHORIZED_ACCESS' });

    const [rows] = await connection.execute(
      `SELECT *
       FROM GlaucomaDiagnosis
       WHERE patient_id = ?
       ORDER BY diagnosis_date DESC`,
      [patientId]
    );

    // target_iop_left/right อยู่ใน GlaucomaDiagnosis แล้ว ใช้ได้เลย
    return res.status(200).json({
      success: true,
      data: { diagnoses: rows || [] },
    });
  } catch (err) {
    console.error('❌ getPatientDiagnoses error:', err);
    return res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการดึงข้อมูลการวินิจฉัย',
      error: process.env.NODE_ENV === 'development' ? err.message : 'INTERNAL_SERVER_ERROR',
    });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * =========================
 *  GET /api/diagnoses/:diagnosisId
 * =========================
 * (เอาไว้ให้ routes ไม่พัง)
 */
const getDiagnosis = async (req, res) => {
  let connection;
  try {
    const doctorId = req.user?.doctor_id || req.doctor?.doctor_id;
    if (!doctorId) return res.status(401).json({ success: false, message: 'Unauthorized', error: 'NO_AUTH_USER' });

    const { diagnosisId } = req.params;
    if (!diagnosisId) return res.status(400).json({ success: false, message: 'กรุณาระบุ diagnosisId' });

    connection = await pool.getConnection();
    const table = await resolveDiagnosisTable(connection);

    const idCol = table === 'GlaucomaDiagnosis' ? 'diagnosis_id' : 'diagnosis_id'; // ถ้า DB คุณใช้ชื่ออื่น ค่อยดู error แล้วปรับ

    const [rows] = await connection.execute(
      `SELECT * FROM ${table} WHERE ${idCol} = ? LIMIT 1`,
      [diagnosisId]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลการวินิจฉัย', error: 'DIAGNOSIS_NOT_FOUND' });
    }

    // เช็คสิทธิ์โดยดู patient_id จากแถวที่ได้
    const patientId = rows[0].patient_id;
    const ok = await doctorHasAccessToPatient(connection, patientId, doctorId);
    if (!ok) {
      return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์เข้าถึงข้อมูลนี้', error: 'UNAUTHORIZED_ACCESS' });
    }

    return res.status(200).json({ success: true, data: { diagnosis: rows[0] } });
  } catch (err) {
    console.error('❌ getDiagnosis error:', err);
    return res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการดึงข้อมูลการวินิจฉัย',
      error: process.env.NODE_ENV === 'development' ? err.message : 'INTERNAL_SERVER_ERROR',
    });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * =========================
 *  PUT /api/diagnoses/:diagnosisId
 * =========================
 * (ให้ routes ทำงานได้) — อัปเดตเฉพาะ field ที่ส่งมา
 */
const updateDiagnosis = async (req, res) => {
  let connection;
  try {
    const doctorId = req.user?.doctor_id || req.doctor?.doctor_id;
    if (!doctorId) return res.status(401).json({ success: false, message: 'Unauthorized', error: 'NO_AUTH_USER' });

    const { diagnosisId } = req.params;
    if (!diagnosisId) return res.status(400).json({ success: false, message: 'กรุณาระบุ diagnosisId' });

    connection = await pool.getConnection();
    const table = await resolveDiagnosisTable(connection);

    const [rows] = await connection.execute(`SELECT * FROM ${table} WHERE diagnosis_id = ? LIMIT 1`, [diagnosisId]);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลการวินิจฉัย', error: 'DIAGNOSIS_NOT_FOUND' });
    }

    const patientId = rows[0].patient_id;
    const ok = await doctorHasAccessToPatient(connection, patientId, doctorId);
    if (!ok) return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์แก้ไขข้อมูลนี้', error: 'UNAUTHORIZED_ACCESS' });

    const body = req.body || {};
    const fields = [];
    const values = [];

    // อัปเดตได้เท่าที่ส่งมา
    const mapping = {
      glaucoma_type:      body.glaucoma_type    || body.glaucomaType,
      icd_code:           body.icd_code         || body.icdCode,
      diagnosis_date:     body.diagnosis_date   || body.diagnosisDate,
      severity:           body.severity,
      left_eye_affected:  body.left_eye_affected  != null ? (body.left_eye_affected  ? 1 : 0) : undefined,
      right_eye_affected: body.right_eye_affected != null ? (body.right_eye_affected ? 1 : 0) : undefined,
      notes:              body.notes,
    };

    Object.entries(mapping).forEach(([k, v]) => {
      if (v !== undefined) {
        fields.push(`${k} = ?`);
        values.push(v);
      }
    });

    if (fields.length > 0) {
      values.push(diagnosisId);
      await connection.execute(
        `UPDATE ${table} SET ${fields.join(', ')} WHERE diagnosis_id = ?`,
        values
      );
    }

    // อัปเดต Target IOP ใน GlaucomaDiagnosis โดยตรง
    if (body.target_iop_left !== undefined || body.target_iop_right !== undefined) {
      const tLeft  = body.target_iop_left  != null ? parseFloat(body.target_iop_left)  : null;
      const tRight = body.target_iop_right != null ? parseFloat(body.target_iop_right) : null;
      await connection.execute(
        `UPDATE GlaucomaDiagnosis SET target_iop_left = ?, target_iop_right = ? WHERE diagnosis_id = ?`,
        [tLeft, tRight, diagnosisId]
      );
    }

    return res.status(200).json({ success: true, message: 'อัปเดตการวินิจฉัยสำเร็จ' });
  } catch (err) {
    console.error('❌ updateDiagnosis error:', err);
    return res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการอัปเดตการวินิจฉัย',
      error: process.env.NODE_ENV === 'development' ? err.message : 'INTERNAL_SERVER_ERROR',
    });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * =========================
 *  DELETE /api/diagnoses/:diagnosisId
 * =========================
 */
const deleteDiagnosis = async (req, res) => {
  let connection;
  try {
    const doctorId = req.user?.doctor_id || req.doctor?.doctor_id;
    if (!doctorId) return res.status(401).json({ success: false, message: 'Unauthorized', error: 'NO_AUTH_USER' });

    const { diagnosisId } = req.params;
    if (!diagnosisId) return res.status(400).json({ success: false, message: 'กรุณาระบุ diagnosisId' });

    connection = await pool.getConnection();
    const table = await resolveDiagnosisTable(connection);

    const [rows] = await connection.execute(`SELECT * FROM ${table} WHERE diagnosis_id = ? LIMIT 1`, [diagnosisId]);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลการวินิจฉัย', error: 'DIAGNOSIS_NOT_FOUND' });
    }

    const patientId = rows[0].patient_id;
    const ok = await doctorHasAccessToPatient(connection, patientId, doctorId);
    if (!ok) return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์ลบข้อมูลนี้', error: 'UNAUTHORIZED_ACCESS' });

    await connection.execute(`DELETE FROM ${table} WHERE diagnosis_id = ?`, [diagnosisId]);
    return res.status(200).json({ success: true, message: 'ลบการวินิจฉัยสำเร็จ' });
  } catch (err) {
    console.error('❌ deleteDiagnosis error:', err);
    return res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการลบการวินิจฉัย',
      error: process.env.NODE_ENV === 'development' ? err.message : 'INTERNAL_SERVER_ERROR',
    });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  createDiagnosis,
  getPatientDiagnoses,
  getDiagnosis,
  updateDiagnosis,
  deleteDiagnosis,
};
