const supabaseAdmin = require('../utils/supabaseAdmin');

/**
 * GET /api/audit/:documentId
 * Auth required (document owner only)
 *
 * Returns all audit log entries for a document, ordered newest first.
 */
const getDocumentAudit = async (req, res) => {
  try {
    const { documentId } = req.params;
    const userId         = req.user.id;

    /* ── Verify document ownership ───────────────────────────────── */
    const { data: doc, error: docErr } = await supabaseAdmin
      .from('documents')
      .select('id, user_id')
      .eq('id', documentId)
      .single();

    if (docErr || !doc) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }

    if (doc.user_id !== userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    /* ── Fetch audit logs ────────────────────────────────────────── */
    const { data: logs, error: logsErr } = await supabaseAdmin
      .from('audit_logs')
      .select('*')
      .eq('document_id', documentId)
      .order('created_at', { ascending: false });

    if (logsErr) {
      console.error('Audit logs fetch error:', logsErr);
      return res.status(500).json({ success: false, error: 'Failed to fetch audit logs' });
    }

    res.json({
      success: true,
      data:    logs || [],
      count:   logs?.length || 0,
    });

  } catch (err) {
    console.error('getDocumentAudit error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

module.exports = { getDocumentAudit };