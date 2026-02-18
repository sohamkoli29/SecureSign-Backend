const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  createSignature,
  getDocumentSignatures,
  updateSignaturePosition,
  updateSignatureStatus,
  deleteSignature,
} = require('../controllers/signatureController');
const {
  sendSigningLink,
  getPublicSigningRequest,
  submitPublicSignature,
  submitPublicRejection,
} = require('../controllers/publicSignController');

// ── PUBLIC ROUTES — no JWT needed ─────────────────────────────────
// Must be defined BEFORE router.use(protect)
router.get('/public/:token',        getPublicSigningRequest);
router.post('/public/:token/sign',  submitPublicSignature);
router.post('/public/:token/reject', submitPublicRejection);

// ── All routes below require auth ─────────────────────────────────
router.use(protect);

// ── Send signing link (owner only) ────────────────────────────────
router.post('/:id/send-link', sendSigningLink);

// ── Standard signature CRUD ───────────────────────────────────────
router.post('/',                           createSignature);
router.get('/document/:documentId',        getDocumentSignatures);
router.put('/:id/position',                updateSignaturePosition);
router.patch('/:id/status',                updateSignatureStatus);
router.delete('/:id',                      deleteSignature);

module.exports = router;