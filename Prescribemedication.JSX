import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { patientService, medicationService } from '../services/api';
import {
  ArrowLeft,
  Plus,
  Trash2,
  Save,
  Clock,
  Eye,
  AlertCircle,
  CheckCircle,
  Search,
} from 'lucide-react';
import './PrescribeMedication.css';

export default function PrescribeMedication() {
  const { patientId } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [patient, setPatient] = useState(null);
  const [availableMedications, setAvailableMedications] = useState([]);
  const [prescriptions, setPrescriptions] = useState([]);
  const [showSuccess, setShowSuccess] = useState(false);
  const [searchTerms, setSearchTerms] = useState({});
  const [showDropdown, setShowDropdown] = useState({});

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  const fetchData = async () => {
    try {
      setLoading(true);

      // Fetch patient info
      const patientResponse = await patientService.getPatientById(patientId);
      setPatient(patientResponse.data || null);

      // Fetch available medications
      const medsResponse = await medicationService.getAllMedications();
      setAvailableMedications(medsResponse.data?.medications || []);

      // Initialize with one empty prescription
      addPrescription();
    } catch (error) {
      console.error('Error fetching data:', error);
      alert('เกิดข้อผิดพลาดในการโหลดข้อมูล');
    } finally {
      setLoading(false);
    }
  };

  const addPrescription = () => {
    const newPrescription = {
      id: Date.now(),
      medication_id: '',
      eye: 'both',
      dosage: '1 drop',
      frequency: 'Once daily',
      duration_days: 30,
      schedules: [
        {
          time_of_day: 'morning',
          scheduled_time: '08:00',
          days_of_week: '1,2,3,4,5,6,7',
        },
      ],
    };
    setPrescriptions([...prescriptions, newPrescription]);
  };

  const removePrescription = (id) => {
    setPrescriptions(prescriptions.filter((p) => p.id !== id));
    // Clean up search terms
    setSearchTerms(prev => {
      const newTerms = { ...prev };
      delete newTerms[id];
      return newTerms;
    });
  };

  const updatePrescription = (id, field, value) => {
    setPrescriptions(
      prescriptions.map((p) => (p.id === id ? { ...p, [field]: value } : p))
    );
  };

  const addSchedule = (prescriptionId) => {
    setPrescriptions(
      prescriptions.map((p) =>
        p.id === prescriptionId
          ? {
              ...p,
              schedules: [
                ...p.schedules,
                {
                  time_of_day: 'evening',
                  scheduled_time: '20:00',
                  days_of_week: '1,2,3,4,5,6,7',
                },
              ],
            }
          : p
      )
    );
  };

  const removeSchedule = (prescriptionId, scheduleIndex) => {
    setPrescriptions(
      prescriptions.map((p) =>
        p.id === prescriptionId
          ? {
              ...p,
              schedules: p.schedules.filter((_, i) => i !== scheduleIndex),
            }
          : p
      )
    );
  };

  const updateSchedule = (prescriptionId, scheduleIndex, field, value) => {
    setPrescriptions(
      prescriptions.map((p) =>
        p.id === prescriptionId
          ? {
              ...p,
              schedules: p.schedules.map((s, i) =>
                i === scheduleIndex ? { ...s, [field]: value } : s
              ),
            }
          : p
      )
    );
  };

  const getFilteredMedications = (prescriptionId) => {
    const searchTerm = searchTerms[prescriptionId] || '';
    
    if (!searchTerm.trim()) {
      return availableMedications;
    }

    return availableMedications.filter(med => 
      med.name.toLowerCase().startsWith(searchTerm.toLowerCase()) ||
      med.generic_name.toLowerCase().startsWith(searchTerm.toLowerCase())
    );
  };

  const handleSearchChange = (prescriptionId, value) => {
    setSearchTerms(prev => ({
      ...prev,
      [prescriptionId]: value
    }));
    setShowDropdown(prev => ({
      ...prev,
      [prescriptionId]: true
    }));
  };

  const selectMedication = (prescriptionId, medicationId, medicationName) => {
    updatePrescription(prescriptionId, 'medication_id', medicationId);
    setSearchTerms(prev => ({
      ...prev,
      [prescriptionId]: medicationName
    }));
    setShowDropdown(prev => ({
      ...prev,
      [prescriptionId]: false
    }));
  };

  const getSelectedMedicationName = (prescriptionId) => {
    const prescription = prescriptions.find(p => p.id === prescriptionId);
    if (!prescription?.medication_id) return '';
    
    const med = availableMedications.find(m => m.medication_id === prescription.medication_id);
    return med ? `${med.name} (${med.generic_name})` : '';
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Validation
    if (prescriptions.length === 0) {
      alert('กรุณาเพิ่มยาอย่างน้อย 1 รายการ');
      return;
    }

    for (const p of prescriptions) {
      if (!p.medication_id) {
        alert('กรุณาเลือกยาทุกรายการ');
        return;
      }
      if (p.schedules.length === 0) {
        alert('กรุณากำหนดตารางเวลาใช้ยาทุกรายการ');
        return;
      }
    }

    try {
      setSaving(true);

      // Prepare data
      const medicationsData = prescriptions.map((p) => ({
        medication_id: p.medication_id,
        eye: p.eye,
        dosage: p.dosage,
        frequency: p.frequency,
        duration_days: parseInt(p.duration_days),
        schedules: p.schedules.map((s) => ({
          time_of_day: s.time_of_day,
          scheduled_time: s.scheduled_time + ':00',
          days_of_week: s.days_of_week,
        })),
      }));

      await medicationService.prescribeMedication({
        patient_id: patientId,
        medications: medicationsData,
      });





      setShowSuccess(true);
      setTimeout(() => {
        navigate(`/patients/${patientId}`);
      }, 2000);
    } catch (error) {
      console.error('Error prescribing medications:', error);
      alert('เกิดข้อผิดพลาดในการสั่งยา: ' + (error.response?.data?.message || error.message));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="loading-container">
        <div className="spinner"></div>
        <p>กำลังโหลดข้อมูล...</p>
      </div>
    );
  }

  return (
    <div className="prescribe-medication-page fade-in">
      {/* Success Message */}
      {showSuccess && (
        <div className="success-overlay">
          <div className="success-card">
            <CheckCircle size={64} color="#48bb78" />
            <h2>สั่งยาสำเร็จ!</h2>
            <p>กำลังกลับไปหน้ารายละเอียดผู้ป่วย...</p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="page-header">
        <button className="btn-back" onClick={() => navigate(-1)}>
          <ArrowLeft size={20} />
          ย้อนกลับ
        </button>
        <div>
          <h1>สั่งยา</h1>
          <p>
            ผู้ป่วย: {patient?.full_name} (HN: {patient?.patient_hn})
          </p>
        </div>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit}>
        {/* Prescriptions List */}
        <div className="prescriptions-container">
          {prescriptions.map((prescription, index) => (
            <div key={prescription.id} className="prescription-card">
              <div className="card-header">
                <h3>ยาที่ {index + 1}</h3>
                {prescriptions.length > 1 && (
                  <button
                    type="button"
                    className="btn-icon btn-danger"
                    onClick={() => removePrescription(prescription.id)}
                    title="ลบยานี้"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>

              <div className="card-content">
                {/* Medication Selection with Search */}
                <div className="form-group">
                  <label>
                    เลือกยา <span className="required">*</span>
                  </label>
                  <div className="searchable-select">
                    <div className="search-input-wrapper">
                      <Search size={16} className="search-icon" />
                      <input
                        type="text"
                        className="form-input search-input"
                        placeholder="พิมพ์ชื่อยาเพื่อค้นหา..."
                        value={searchTerms[prescription.id] || getSelectedMedicationName(prescription.id)}
                        onChange={(e) => handleSearchChange(prescription.id, e.target.value)}
                        onFocus={() => setShowDropdown(prev => ({ ...prev, [prescription.id]: true }))}
                      />
                    </div>
                    
                    {showDropdown[prescription.id] && (
                      <div className="dropdown-list">
                        {getFilteredMedications(prescription.id).length > 0 ? (
                          getFilteredMedications(prescription.id).map((med) => (
                            <div
                              key={med.medication_id}
                              className={`dropdown-item ${prescription.medication_id === med.medication_id ? 'selected' : ''}`}
                              onClick={() => selectMedication(prescription.id, med.medication_id, med.name)}
                            >
                              <div className="med-name">{med.name}</div>
                              <div className="med-details">
                                {med.generic_name} • {med.category}
                              </div>
                            </div>
                          ))
                        ) : (
                          <div className="dropdown-item disabled">
                            ไม่พบยาที่ตรงกับคำค้นหา
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  {prescription.medication_id && (
                    <div className="selected-med-badge">
                      ✓ เลือกแล้ว: {getSelectedMedicationName(prescription.id)}
                    </div>
                  )}
                </div>

                {/* Eye Selection */}
                <div className="form-row">
                  <div className="form-group">
                    <label>
                      <Eye size={16} />
                      ตา
                    </label>
                    <select
                      value={prescription.eye}
                      onChange={(e) =>
                        updatePrescription(prescription.id, 'eye', e.target.value)
                      }
                      className="form-select"
                    >
                      <option value="both">ทั้งสองข้าง</option>
                      <option value="left">ซ้าย</option>
                      <option value="right">ขวา</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label>ขนาดยา</label>
                    <input
                      type="text"
                      value={prescription.dosage}
                      onChange={(e) =>
                        updatePrescription(prescription.id, 'dosage', e.target.value)
                      }
                      className="form-input"
                      placeholder="เช่น 1 drop, 1 tablet"
                    />
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label>ความถี่</label>
                    <select
                      value={prescription.frequency}
                      onChange={(e) =>
                        updatePrescription(prescription.id, 'frequency', e.target.value)
                      }
                      className="form-select"
                    >
                      <option value="Once daily">วันละ 1 ครั้ง</option>
                      <option value="Twice daily">วันละ 2 ครั้ง</option>
                      <option value="Three times daily">วันละ 3 ครั้ง</option>
                      <option value="Four times daily">วันละ 4 ครั้ง</option>
                      <option value="Every other day">วันเว้นวัน</option>
                      <option value="Weekly">สัปดาห์ละครั้ง</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label>ระยะเวลา (วัน)</label>
                    <input
                      type="number"
                      value={prescription.duration_days}
                      onChange={(e) =>
                        updatePrescription(prescription.id, 'duration_days', e.target.value)
                      }
                      className="form-input"
                      min="1"
                      max="365"
                    />
                  </div>
                </div>

                {/* Schedules */}
                <div className="schedules-section">
                  <div className="section-header">
                    <h4>
                      <Clock size={16} />
                      ตารางเวลาใช้ยา
                    </h4>
                    <button
                      type="button"
                      className="btn-sm btn-secondary"
                      onClick={() => addSchedule(prescription.id)}
                    >
                      <Plus size={14} />
                      เพิ่มเวลา
                    </button>
                  </div>

                  {prescription.schedules.map((schedule, scheduleIndex) => (
                    <div key={scheduleIndex} className="schedule-item">
                      <div className="form-row">
                        <div className="form-group">
                          <label>ช่วงเวลา</label>
                          <select
                            value={schedule.time_of_day}
                            onChange={(e) =>
                              updateSchedule(
                                prescription.id,
                                scheduleIndex,
                                'time_of_day',
                                e.target.value
                              )
                            }
                            className="form-select"
                          >
                            <option value="morning">เช้า</option>
                            <option value="afternoon">บ่าย</option>
                            <option value="evening">เย็น</option>
                            <option value="night">ก่อนนอน</option>
                          </select>
                        </div>

                        <div className="form-group">
                          <label>เวลา</label>
                          <input
                            type="time"
                            value={schedule.scheduled_time}
                            onChange={(e) =>
                              updateSchedule(
                                prescription.id,
                                scheduleIndex,
                                'scheduled_time',
                                e.target.value
                              )
                            }
                            className="form-input"
                          />
                        </div>

                        {prescription.schedules.length > 1 && (
                          <button
                            type="button"
                            className="btn-icon btn-danger"
                            onClick={() => removeSchedule(prescription.id, scheduleIndex)}
                            title="ลบเวลานี้"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>

                      <div className="days-of-week">
                        <label>วันที่ใช้:</label>
                        <div className="day-checkboxes">
                          {['1', '2', '3', '4', '5', '6', '7'].map((day) => {
                            const dayNames = ['', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา'];
                            const isChecked = schedule.days_of_week
                              .split(',')
                              .includes(day);

                            return (
                              <label key={day} className="day-checkbox">
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={(e) => {
                                    const days = schedule.days_of_week.split(',');
                                    let newDays;
                                    if (e.target.checked) {
                                      newDays = [...days, day].filter((d) => d);
                                    } else {
                                      newDays = days.filter((d) => d !== day);
                                    }
                                    updateSchedule(
                                      prescription.id,
                                      scheduleIndex,
                                      'days_of_week',
                                      newDays.sort().join(',')
                                    );
                                  }}
                                />
                                <span>{dayNames[parseInt(day)]}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}

          {/* Add Medication Button */}
          <button type="button" className="btn btn-secondary btn-add-med" onClick={addPrescription}>
            <Plus size={20} />
            เพิ่มยาอีก 1 รายการ
          </button>
        </div>

        {/* Action Buttons */}
        <div className="action-buttons">
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => navigate(-1)}
            disabled={saving}
          >
            ยกเลิก
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? (
              <>
                <div className="spinner-small"></div>
                กำลังบันทึก...
              </>
            ) : (
              <>
                <Save size={20} />
                บันทึกการสั่งยา
              </>
            )}
          </button>
        </div>

        {/* Info Box */}
        <div className="info-box">
          <AlertCircle size={20} />
          <div>
            <strong>คำแนะนำ:</strong>
            <ul>
              <li>พิมพ์ชื่อยาเพื่อค้นหา ระบบจะกรองรายการให้อัตโนมัติ</li>
              <li>ตรวจสอบยาและขนาดยาให้ถูกต้องก่อนบันทึก</li>
              <li>กำหนดเวลาใช้ยาให้เหมาะสมกับผู้ป่วย</li>
            </ul>
          </div>
        </div>
      </form>
    </div>
  );
}
