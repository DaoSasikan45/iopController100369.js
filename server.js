// server.js
const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Import routes
const authRoutes = require('./routes/authRoutes');
const patientRoutes = require('./routes/patientRoutes');
const iopRoutes = require('./routes/iopRoutes');
const medicationRoutes = require('./routes/medicationRoutes'); 
const medicationLogRoutes = require('./routes/medicationLogRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const fileRoutes = require('./routes/fileRoutes');
const octRoutes = require('./routes/octRoutes');
const visualFieldRoutes = require('./routes/visualFieldRoutes');
const appointmentRoutes = require('./routes/appointmentRoutes');
const reportRoutes = require('./routes/reportRoutes');
const medicationReminderRoutes = require('./routes/medicationReminderRoutes');
const diagnosisRoutes = require('./routes/diagnosisRoutes');

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

// Routes (ก่อน/หลังไม่ซีเรียส แต่แนะนำจัดกลุ่มให้อ่านง่าย)
app.use('/api', fileRoutes);
app.use('/api', octRoutes);
app.use('/api', visualFieldRoutes);
app.use('/api', appointmentRoutes);
app.use('/api', reportRoutes);
app.use('/api/medication-reminders', medicationReminderRoutes);
app.use('/api', diagnosisRoutes);

// Request logging (Development)
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
  });
}

// Routes
app.use('/api/auth', authRoutes);
app.use('/api', medicationRoutes);
app.use('/api', patientRoutes);
app.use('/api', iopRoutes);
app.use('/api', medicationLogRoutes);
app.use('/api', notificationRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'EyeMate API is running',
    timestamp: new Date().toISOString()
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'ไม่พบ endpoint ที่ระบุ',
    error: 'NOT_FOUND'
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('❌ Server Error:', err);

  res.status(err.status || 500).json({
    success: false,
    message: 'เกิดข้อผิดพลาดของเซิร์ฟเวอร์',
    error: process.env.NODE_ENV === 'development' ? err.message : 'INTERNAL_SERVER_ERROR'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
