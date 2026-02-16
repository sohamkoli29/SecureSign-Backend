    const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  createSignature,
  getDocumentSignatures,
  updateSignaturePosition,
  deleteSignature,
  updateSignatureStatus
} = require('../controllers/signatureController');

// All routes are protected
router.use(protect);

// Create new signature
router.post('/', createSignature);

// Get signatures for a document
router.get('/document/:documentId', getDocumentSignatures);

// Update signature position
router.put('/:id/position', updateSignaturePosition);

// Update signature status
router.patch('/:id/status', updateSignatureStatus);

// Delete signature
router.delete('/:id', deleteSignature);

module.exports = router;