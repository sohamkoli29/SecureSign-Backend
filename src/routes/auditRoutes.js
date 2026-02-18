const express = require('express');
const router  = express.Router();
const { protect }         = require('../middleware/authMiddleware');
const { getDocumentAudit } = require('../controllers/auditController');

// All routes require auth
router.use(protect);

router.get('/:documentId', getDocumentAudit);

module.exports = router;