const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { upload, handleMulterError } = require('../middleware/uploadMiddleware');
const {
  uploadDocument,
  getDocuments,
  getDocumentById,
  updateDocument,
  deleteDocument,
  downloadDocument,
  getDocumentStats,
  searchDocuments,
  getRecentDocuments
} = require('../controllers/documentController');

// All routes are protected
router.use(protect);

// Special routes first
router.get('/stats', getDocumentStats);
router.get('/search', searchDocuments);
router.get('/recent', getRecentDocuments);

// Upload route with multer middleware
router.post('/upload', upload.single('document'), handleMulterError, uploadDocument);

// CRUD routes
router.get('/', getDocuments);
router.get('/:id', getDocumentById);
router.put('/:id', updateDocument);
router.delete('/:id', deleteDocument);
router.get('/:id/download', downloadDocument);

module.exports = router;