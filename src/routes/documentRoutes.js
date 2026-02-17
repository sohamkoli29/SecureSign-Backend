const express = require('express');
const router  = express.Router();
const { protect }  = require('../middleware/authMiddleware');
const { upload, handleMulterError }  = require('../middleware/uploadMiddleware');
const {
  uploadDocument,
  getDocuments,
  getDocumentById,
  updateDocument,
  deleteDocument,
  downloadDocument,
  getDocumentStats,
  searchDocuments,
  getRecentDocuments,
} = require('../controllers/documentController');
const { finalizeDocument } = require('../controllers/finalizeController');

// All routes require auth
router.use(protect);

// ── Special named routes first (before /:id) ──────────────────────
router.get('/stats',  getDocumentStats);
router.get('/search', searchDocuments);
router.get('/recent', getRecentDocuments);

// ── Upload ─────────────────────────────────────────────────────────
router.post('/upload', upload.single('document'), handleMulterError, uploadDocument);

// ── CRUD ───────────────────────────────────────────────────────────
router.get('/',    getDocuments);
router.get('/:id', getDocumentById);
router.put('/:id', updateDocument);
router.delete('/:id', deleteDocument);

// ── Download original ──────────────────────────────────────────────
router.get('/:id/download', downloadDocument);

// ── Finalize: burn signatures into PDF and upload signed copy ──────
router.post('/:id/finalize', finalizeDocument);

module.exports = router;