// routes/medicationRoutes.js
const express = require('express');
const { body } = require('express-validator');

const {
  prescribeMedications,
  getPatientMedications,
  updatePrescription,
  updateMedicationReminder,
  getAllMedications,
} = require('../controllers/medicationController');

const validateRequest = require('../middleware/validateRequest');
const verifyToken = require('../middleware/verifyToken');

const router = express.Router();

/**
 * @route   GET /api/medications
 * @desc    ดึงรายการยาทั้งหมด
 * @access  Private (Doctor only)
 */
router.get(
  '/medications',
  (req, res, next) => {
    console.log('📋 [MEDS] GET /medications route hit');
    next();
  },
  verifyToken,
  (req, res, next) => {
    console.log('📋 [MEDS] After verifyToken, calling getAllMedications');
    next();
  },
  getAllMedications
);

/**
 * ✅ (เพิ่มใหม่) GET /api/patients/:patientId/medications
 * ให้ตรงกับ frontend: GET /patients/:patientId/medications?status=active
 */
router.get(
  '/patients/:patientId/medications',
  (req, res, next) => {
    console.log('📋 [MEDS] GET /patients/:patientId/medications hit:', req.params.patientId);
    next();
  },
  verifyToken,
  getPatientMedications
);

/**
 * Validation rules สำหรับสั่งยา (POST /api/medications)
 */
const prescribeMedicationsValidation = [
  body('patient_id')
    .trim()
    .notEmpty().withMessage('กรุณาระบุ patient_id')
    .isString().withMessage('patient_id ต้องเป็น string'),

  body('medications')
    .isArray({ min: 1 }).withMessage('medications ต้องเป็น array และมีอย่างน้อย 1 รายการ'),

  body('medications.*.medication_id')
    .trim()
    .notEmpty().withMessage('กรุณาระบุ medication_id')
    .isString().withMessage('medication_id ต้องเป็น string'),

  body('medications.*.eye')
    .trim()
    .notEmpty().withMessage('กรุณาระบุ eye')
    .isIn(['left', 'right', 'both']).withMessage('eye ต้องเป็น left, right หรือ both'),

  body('medications.*.dosage')
    .trim()
    .notEmpty().withMessage('กรุณาระบุ dosage')
    .isString().withMessage('dosage ต้องเป็น string'),

  body('medications.*.frequency')
    .trim()
    .notEmpty().withMessage('กรุณาระบุ frequency')
    .isString().withMessage('frequency ต้องเป็น string'),

  body('medications.*.duration_days')
    .notEmpty().withMessage('กรุณาระบุ duration_days')
    .isInt({ min: 1 }).withMessage('duration_days ต้องเป็นตัวเลขมากกว่า 0'),

  body('medications.*.schedules')
    .optional()
    .isArray().withMessage('schedules ต้องเป็น array'),

  body('medications.*.schedules.*.time_of_day')
    .optional()
    .isIn(['morning', 'afternoon', 'evening'])
    .withMessage('time_of_day ต้องเป็น morning, afternoon หรือ evening'),

  body('medications.*.schedules.*.scheduled_time')
    .optional()
    .matches(/^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/)
    .withMessage('scheduled_time ต้องเป็นรูปแบบ HH:MM:SS'),
];

/**
 * @route   POST /api/medications
 * @desc    สั่งยาให้ผู้ป่วย (รองรับหลายยาพร้อมกัน)
 * @access  Private (Doctor only)
 */
router.post(
  '/medications',
  (req, res, next) => {
    console.log('💊 [MEDS] POST /medications hit');
    next();
  },
  verifyToken,
  prescribeMedicationsValidation,
  validateRequest,
  prescribeMedications
);

/**
 * ✅ (เพิ่มใหม่) POST /api/patients/:patientId/medications
 * ให้ตรงกับ frontend ใน api.js:
 *   api.post(`/patients/${id}/medications`, payload)
 *
 * เราจะ map patientId จาก params → body.patient_id แล้วใช้ validation+controller เดิม
 */
router.post(
  '/patients/:patientId/medications',
  (req, res, next) => {
    console.log('💊 [MEDS] POST /patients/:patientId/medications hit:', req.params.patientId);
    // map ให้ controller เดิมใช้ได้
    req.body = req.body || {};
    req.body.patient_id = req.params.patientId;
    next();
  },
  verifyToken,
  prescribeMedicationsValidation,
  validateRequest,
  prescribeMedications
);

/**
 * @route   PUT /api/medications/:prescriptionId
 * @desc    หยุดยาหรือแก้ไขข้อมูลยา
 * @access  Private (Doctor only)
 */
router.put(
  '/medications/:prescriptionId',
  verifyToken,
  updatePrescription
);

/**
 * @route   PUT /api/medication-reminders/:reminderId
 * @desc    แก้ไขเวลาหยอดยา
 * @access  Private (Doctor only)
 */
router.put(
  '/medication-reminders/:reminderId',
  verifyToken,
  updateMedicationReminder
);

module.exports = router;
