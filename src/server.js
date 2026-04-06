const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const supabase = require('./utils/supabase');
// Load environment variables
dotenv.config();

const app = express();

// Import routes
const authRoutes = require('./routes/authRoutes');
const documentRoutes = require('./routes/documentRoutes');
const signatureRoutes = require('./routes/signatureRoutes'); // Add this
const auditRoutes = require('./routes/auditRoutes');
// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true
}));
  
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/signatures', signatureRoutes); // Add this
app.use('/api/audit', auditRoutes);
// Basic route for testing
app.get('/api/health', async (req, res) => {
  try {
    await supabase.from('test').select('message').limit(1).single();
    res.status(200).json({ alive: true, db: 'connected' });
  } catch (err) {
    res.status(200).json({ alive: true, db: 'error' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    success: false,
    error: 'Something went wrong!',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Handle 404
app.use((req, res) => {
  res.status(404).json({ 
    success: false,
    error: 'Route not found' 
  });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Auth routes available at http://localhost:${PORT}/api/auth`);
  console.log(`Document routes available at http://localhost:${PORT}/api/documents`);
  console.log(`Signature routes available at http://localhost:${PORT}/api/signatures`);
});