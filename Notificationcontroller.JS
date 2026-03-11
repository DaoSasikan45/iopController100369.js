// controllers/notificationController.js
const pool = require('../config/database');

/**
 * ดูการแจ้งเตือนทั้งหมดของแพทย์
 * GET /api/notifications/doctor/:doctorId
 * 
 * Query params:
 * - is_read: '0' | '1' | 'all' (optional, default: 'all')
 * - priority: 'low' | 'medium' | 'high' | 'urgent' | 'all' (optional, default: 'all')
 * - page: number (optional, default: 1)
 * - limit: number (optional, default: 20)
 */
const getDoctorNotifications = async (req, res) => {
  let connection;
  
  try {
    const { doctorId } = req.params;
    const { 
      is_read = 'all', 
      priority = 'all',
      page = 1, 
      limit = 20 
    } = req.query;
    const tokenDoctorId = req.doctor.doctor_id;
    
    // 1. Validate doctorId
    if (!doctorId || typeof doctorId !== 'string' || doctorId.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'รูปแบบ doctor_id ไม่ถูกต้อง',
        error: 'INVALID_DOCTOR_ID'
      });
    }
    
    // 2. ตรวจสอบว่า doctorId ตรงกับ token
    if (doctorId !== tokenDoctorId) {
      return res.status(403).json({
        success: false,
        message: 'คุณไม่มีสิทธิ์เข้าถึงการแจ้งเตือนของแพทย์ท่านอื่น',
        error: 'UNAUTHORIZED_ACCESS'
      });
    }
    
    // 3. Validate is_read
    const validIsRead = ['all', '0', '1'];
    if (!validIsRead.includes(is_read)) {
      return res.status(400).json({
        success: false,
        message: 'is_read ต้องเป็น all, 0 หรือ 1',
        error: 'INVALID_IS_READ'
      });
    }
    
    // 4. Validate priority
    const validPriority = ['all', 'low', 'medium', 'high', 'urgent'];
    if (!validPriority.includes(priority)) {
      return res.status(400).json({
        success: false,
        message: 'priority ต้องเป็น all, low, medium, high หรือ urgent',
        error: 'INVALID_PRIORITY'
      });
    }
    
    // 5. Validate pagination
    const pageInt = parseInt(page);
    const limitInt = parseInt(limit);
    
    if (isNaN(pageInt) || pageInt <= 0) {
      return res.status(400).json({
        success: false,
        message: 'page ต้องเป็นตัวเลขมากกว่า 0',
        error: 'INVALID_PAGE'
      });
    }
    
    if (isNaN(limitInt) || limitInt <= 0 || limitInt > 100) {
      return res.status(400).json({
        success: false,
        message: 'limit ต้องเป็นตัวเลข 1-100',
        error: 'INVALID_LIMIT'
      });
    }
    
    // 6. Get connection
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
    
    // 7. Build WHERE clauses
    const conditions = ['n.user_id = ?'];
    const params = [doctorId];
    
    if (is_read !== 'all') {
      conditions.push('n.is_read = ?');
      params.push(parseInt(is_read));
    }
    
    if (priority !== 'all') {
      conditions.push('n.priority = ?');
      params.push(priority);
    }
    
    const whereClause = conditions.join(' AND ');
    
    // 8. นับจำนวนทั้งหมด
    const [countResult] = await connection.execute(
      `SELECT COUNT(*) as total FROM Notifications n WHERE ${whereClause}`,
      params
    );
    
    const totalNotifications = countResult[0].total;
    
    if (totalNotifications === 0) {
      return res.status(200).json({
        success: true,
        message: 'ไม่มีการแจ้งเตือน',
        data: {
          notifications: [],
          pagination: {
            total: 0,
            page: pageInt,
            limit: limitInt,
            total_pages: 0
          },
          summary: {
            total_unread: 0,
            by_priority: {
              urgent: 0,
              high: 0,
              medium: 0,
              low: 0
            }
          }
        }
      });
    }
    
    // 9. คำนวณ offset
    const offset = (pageInt - 1) * limitInt;
    const totalPages = Math.ceil(totalNotifications / limitInt);
    
    // 10. ดึงข้อมูล notifications
    const [notifications] = await connection.execute(
      `SELECT 
        n.notification_id,
        n.notification_type,
        n.title,
        n.body,
        n.related_entity_type,
        n.related_entity_id,
        n.priority,
        n.is_read,
        n.read_at,
        n.channels,
        n.sent_at,
        n.status,
        n.created_at
       FROM Notifications n
       WHERE ${whereClause}
       ORDER BY n.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limitInt, offset]
    );
    
    // 11. จัดรูปแบบข้อมูล + เพิ่ม icon
    const priorityIcons = {
      'urgent': '🔴',
      'high': '🟠',
      'medium': '🟡',
      'low': '🟢'
    };
    
    const priorityText = {
      'urgent': 'เร่งด่วนมาก',
      'high': 'สำคัญ',
      'medium': 'ปานกลาง',
      'low': 'ทั่วไป'
    };
    
    const formattedNotifications = notifications.map(notif => ({
      notification_id: notif.notification_id,
      type: notif.notification_type,
      title: notif.title,
      body: notif.body,
      priority: {
        level: notif.priority,
        icon: priorityIcons[notif.priority],
        text: priorityText[notif.priority]
      },
      related: {
        type: notif.related_entity_type,
        id: notif.related_entity_id
      },
      is_read: notif.is_read === 1,
      read_at: notif.read_at,
      channels: notif.channels ? notif.channels.split(',') : [],
      status: notif.status,
      sent_at: notif.sent_at,
      created_at: notif.created_at,
      time_ago: calculateTimeAgo(notif.created_at)
    }));
    
    // 12. คำนวณสถิติ
    const [unreadCount] = await connection.execute(
      `SELECT COUNT(*) as count FROM Notifications 
       WHERE user_id = ? AND is_read = 0`,
      [doctorId]
    );
    
    const [priorityStats] = await connection.execute(
      `SELECT 
        priority,
        COUNT(*) as count
       FROM Notifications
       WHERE user_id = ? AND is_read = 0
       GROUP BY priority`,
      [doctorId]
    );
    
    const byPriority = {
      urgent: 0,
      high: 0,
      medium: 0,
      low: 0
    };
    
    priorityStats.forEach(stat => {
      byPriority[stat.priority] = stat.count;
    });
    
    // 13. ส่ง response
    return res.status(200).json({
      success: true,
      message: `พบการแจ้งเตือน ${notifications.length} รายการ`,
      data: {
        notifications: formattedNotifications,
        pagination: {
          total: totalNotifications,
          page: pageInt,
          limit: limitInt,
          total_pages: totalPages,
          has_next: pageInt < totalPages,
          has_prev: pageInt > 1
        },
        summary: {
          total_unread: unreadCount[0].count,
          by_priority: byPriority
        }
      }
    });
    
  } catch (error) {
    console.error('❌ Get Doctor Notifications Error:', error);
    
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      return res.status(503).json({
        success: false,
        message: 'การเชื่อมต่อฐานข้อมูลขาดหาย',
        error: 'DATABASE_CONNECTION_LOST'
      });
    }
    
    return res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการดึงการแจ้งเตือน',
      error: process.env.NODE_ENV === 'development' ? error.message : 'INTERNAL_SERVER_ERROR'
    });
    
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

/**
 * Helper function: คำนวณเวลาที่ผ่านมา
 */
function calculateTimeAgo(date) {
  const now = new Date();
  const past = new Date(date);
  const diffMs = now - past;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'เมื่อสักครู่';
  if (diffMins < 60) return `${diffMins} นาทีที่แล้ว`;
  if (diffHours < 24) return `${diffHours} ชั่วโมงที่แล้ว`;
  if (diffDays < 7) return `${diffDays} วันที่แล้ว`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} สัปดาห์ที่แล้ว`;
  return `${Math.floor(diffDays / 30)} เดือนที่แล้ว`;
}

/**
 * ส่งข้อความแจ้งเตือนพิเศษให้ผู้ป่วย
 * POST /api/notifications
 * 
 * Body:
 * - patient_id: required
 * - title: required
 * - message: required (max 500 chars)
 * - priority: optional ('low' | 'medium' | 'high' | 'urgent', default: 'medium')
 */
const sendCustomNotification = async (req, res) => {
  let connection;
  
  try {
    const { patient_id, title, message, priority = 'medium' } = req.body;
    const doctorId = req.user?.doctor_id || req.doctor?.doctor_id;
    if (!doctorId) {
      return res.status(401).json({
        success: false,
        message: 'ไม่ได้รับข้อมูลผู้ใช้จาก token กรุณาเข้าสู่ระบบใหม่',
        error: 'NO_AUTH_USER'
      });
    }

    
    // 1. Validate patient_id
    if (!patient_id || typeof patient_id !== 'string' || patient_id.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'patient_id ต้องไม่เป็นค่าว่าง',
        error: 'INVALID_PATIENT_ID'
      });
    }
    
    // 2. Validate title
    if (!title || typeof title !== 'string' || title.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'title ต้องไม่เป็นค่าว่าง',
        error: 'INVALID_TITLE'
      });
    }
    
    if (title.length > 100) {
      return res.status(400).json({
        success: false,
        message: 'title ต้องไม่เกิน 100 ตัวอักษร',
        error: 'TITLE_TOO_LONG'
      });
    }
    
    // 3. Validate message
    if (!message || typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'message ต้องไม่เป็นค่าว่าง',
        error: 'INVALID_MESSAGE'
      });
    }
    
    if (message.length > 500) {
      return res.status(400).json({
        success: false,
        message: 'message ต้องไม่เกิน 500 ตัวอักษร',
        error: 'MESSAGE_TOO_LONG'
      });
    }
    
    // 4. Validate priority
    const validPriority = ['low', 'medium', 'high', 'urgent'];
    if (!validPriority.includes(priority)) {
      return res.status(400).json({
        success: false,
        message: 'priority ต้องเป็น low, medium, high หรือ urgent',
        error: 'INVALID_PRIORITY'
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
    
    // 6. ตรวจสอบว่าผู้ป่วยมีอยู่จริง
    const [patients] = await connection.execute(
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
    
    // 7. ตรวจสอบว่าแพทย์มีสิทธิ์เข้าถึงผู้ป่วยคนนี้หรือไม่
    const [access] = await connection.execute(
      `SELECT COUNT(*) as has_access
       FROM (
         SELECT patient_id FROM GlaucomaDiagnosis WHERE patient_id = ? AND doctor_id = ?
         UNION
         SELECT patient_id FROM GlaucomaTreatmentPlans WHERE patient_id = ? AND doctor_id = ?
         UNION
         SELECT patient_id FROM PatientVisits WHERE patient_id = ? AND doctor_id = ?
       ) AS patient_access`,
      [patient_id, doctorId, patient_id, doctorId, patient_id, doctorId]
    );
    
    if (access[0].has_access === 0) {
      return res.status(403).json({
        success: false,
        message: 'คุณไม่มีสิทธิ์ส่งข้อความถึงผู้ป่วยคนนี้',
        error: 'UNAUTHORIZED_ACCESS'
      });
    }
    
    // 8. สร้าง notification_id (รูปแบบ: NOTIF + timestamp 10 หลัก + random 4 หลัก = รวม 19 ตัว)
    const timestamp = Math.floor(Date.now() / 1000); // เอาแค่วินาที (10 หลัก)
    const randomNum = Math.floor(Math.random() * 10000).toString().padStart(4, '0'); // 4 หลัก
    const notificationId = `NOTIF${timestamp}${randomNum}`;
    
    console.log('Generated notification_id:', notificationId, 'Length:', notificationId.length);
    
    // 9. INSERT notification
    await connection.execute(
      `INSERT INTO Notifications (
        notification_id,
        user_id,
        notification_type,
        title,
        body,
        priority,
        is_read,
        status,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        notificationId,
        patient_id,
        'custom_message',
        title.trim(),
        message.trim(),
        priority,
        0,
        'pending'
      ]
    );
    
    // 10. ดึงข้อมูล notification ที่สร้าง
    const [notifications] = await connection.execute(
      `SELECT 
        notification_id,
        user_id as patient_id,
        notification_type,
        title,
        body,
        priority,
        is_read,
        read_at,
        status,
        created_at
       FROM Notifications
       WHERE notification_id = ?`,
      [notificationId]
    );
    
    const notification = notifications[0];
    const patient = patients[0];
    
    // 11. จัดรูปแบบข้อมูล
    const priorityIcons = {
      'urgent': '🔴',
      'high': '🟠',
      'medium': '🟡',
      'low': '🟢'
    };
    
    const priorityText = {
      'urgent': 'เร่งด่วนมาก',
      'high': 'สำคัญ',
      'medium': 'ปานกลาง',
      'low': 'ทั่วไป'
    };
    
    // 12. ส่ง response
    return res.status(201).json({
      success: true,
      message: 'ส่งข้อความแจ้งเตือนสำเร็จ',
      data: {
        patient: {
          patient_id: patient.patient_id,
          name: `${patient.first_name} ${patient.last_name}`
        },
        notification: {
          notification_id: notification.notification_id,
          type: notification.notification_type,
          title: notification.title,
          message: notification.body,
          priority: {
            level: notification.priority,
            icon: priorityIcons[notification.priority],
            text: priorityText[notification.priority]
          },
          status: notification.status,
          is_read: notification.is_read === 1,
          created_at: notification.created_at
        }
      }
    });
    
  } catch (error) {
    console.error('❌ Send Custom Notification Error:', error);
    
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      return res.status(503).json({
        success: false,
        message: 'การเชื่อมต่อฐานข้อมูลขาดหาย',
        error: 'DATABASE_CONNECTION_LOST'
      });
    }
    
    if (error.code && error.code.startsWith('ER_')) {
      return res.status(500).json({
        success: false,
        message: 'เกิดข้อผิดพลาดในการบันทึกข้อมูล',
        error: 'DATABASE_ERROR',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
    
    return res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการส่งข้อความแจ้งเตือน',
      error: process.env.NODE_ENV === 'development' ? error.message : 'INTERNAL_SERVER_ERROR'
    });
    
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

// Get unread notification count
const getUnreadCount = async (req, res) => {
  let connection;
  
  try {
    const doctorId = req.doctor?.doctor_id;
    
    if (!doctorId) {
      return res.status(401).json({
        success: false,
        message: 'ไม่พบข้อมูล doctor_id'
      });
    }
    
    connection = await pool.getConnection();
    
    const [result] = await connection.execute(
      `SELECT COUNT(*) as unread_count
      FROM Notifications
      WHERE user_id = ?
      AND is_read = 0`,
      [doctorId]
    );
    
    const unreadCount = result[0].unread_count;
    
    return res.json({
      success: true,
      data: {
        unread_count: unreadCount
      }
    });
    
  } catch (error) {
    console.error('❌ [NOTIFICATIONS] Error getting unread count:', error.message);
    return res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการดึงจำนวนการแจ้งเตือน',
      error: error.message
    });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  getDoctorNotifications,
  sendCustomNotification,
  getUnreadCount
};
