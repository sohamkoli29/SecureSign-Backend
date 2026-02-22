const supabase      = require('../utils/supabase');
const supabaseAdmin = require('../utils/supabaseAdmin');
const { Resend }    = require('resend');

const sendEmail = async ({ to, subject, text, html }) => {
  if (!process.env.RESEND_API_KEY) {
    console.log('\n📧 ── MOCK EMAIL ──────────────────────────────');
    console.log(`  To:      ${to}`);
    console.log(`  Subject: ${subject}`);
    console.log('─────────────────────────────────────────────\n');
    return;
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: process.env.FROM_EMAIL || 'SecureSign <onboarding@resend.dev>',
    to,
    subject,
    text,
    html,
  });
};

const createSignature = async (req, res) => {
  try {
    const { document_id, signer_name, coordinates, page_number, signature_data, status } = req.body;
    const userId = req.user.id;

    const { data: doc, error: docErr } = await supabase
      .from('documents')
      .select('id, user_id')
      .eq('id', document_id)
      .eq('user_id', userId)
      .single();

    if (docErr || !doc) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }

    const { data: sig, error } = await supabaseAdmin
      .from('signatures')
      .insert([{
        document_id,
        signer_name:    signer_name || 'Signer',
        coordinates:    coordinates || { x: 80, y: 80 },
        page_number:    page_number || 1,
        signature_data: signature_data || null,
        status:         status || 'pending',
      }])
      .select('*')
      .single();

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to create signature' });
    }

    res.status(201).json({ success: true, data: sig });
  } catch (err) {
    console.error('createSignature error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

const getDocumentSignatures = async (req, res) => {
  try {
    const { documentId } = req.params;
    const userId         = req.user.id;

    const { data: doc, error: docErr } = await supabase
      .from('documents')
      .select('id')
      .eq('id', documentId)
      .eq('user_id', userId)
      .single();

    if (docErr || !doc) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }

    const { data: sigs, error } = await supabaseAdmin
      .from('signatures')
      .select('*')
      .eq('document_id', documentId)
      .order('created_at', { ascending: true });

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch signatures' });
    }

    res.json({ success: true, data: sigs || [] });
  } catch (err) {
    console.error('getDocumentSignatures error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

const updateSignaturePosition = async (req, res) => {
  try {
    const { id }                       = req.params;
    const { coordinates, page_number } = req.body;
    const userId                       = req.user.id;

    const { data: sig, error: sigErr } = await supabaseAdmin
      .from('signatures')
      .select('id, document_id')
      .eq('id', id)
      .single();

    if (sigErr || !sig) {
      return res.status(404).json({ success: false, error: 'Signature not found' });
    }

    const { data: doc, error: docErr } = await supabase
      .from('documents')
      .select('id')
      .eq('id', sig.document_id)
      .eq('user_id', userId)
      .single();

    if (docErr || !doc) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    const { data: updated, error } = await supabaseAdmin
      .from('signatures')
      .update({ coordinates, page_number, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to update position' });
    }

    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('updateSignaturePosition error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

const updateSignatureStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, signature_data, rejection_reason, notify_signer } = req.body;
    const userId = req.user.id;

    const { data: sig, error: sigErr } = await supabaseAdmin
      .from('signatures')
      .select('id, document_id, signer_name, signer_email')
      .eq('id', id)
      .single();

    if (sigErr || !sig) {
      return res.status(404).json({ success: false, error: 'Signature not found' });
    }

    const { data: doc, error: docErr } = await supabaseAdmin
      .from('documents')
      .select('id, user_id, title, file_name')
      .eq('id', sig.document_id)
      .single();

    if (docErr || !doc) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }

    if (doc.user_id !== userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    const updateData = {
      status,
      updated_at: new Date().toISOString(),
    };

    if (signature_data !== undefined) updateData.signature_data = signature_data;
    if (rejection_reason !== undefined) updateData.rejection_reason = rejection_reason;

    const { data: updated, error } = await supabaseAdmin
      .from('signatures')
      .update(updateData)
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to update signature' });
    }

    if (status === 'rejected' && notify_signer && sig.signer_email) {
      const docTitle = doc.title || doc.file_name || 'Document';

      await sendEmail({
        to:      sig.signer_email,
        subject: `Signature Rejected: ${docTitle}`,
        text: [
          `Hi ${sig.signer_name},`,
          '',
          `Your signature for "${docTitle}" has been rejected by the document owner.`,
          '',
          rejection_reason ? `Reason: ${rejection_reason}` : '',
          '',
          'Please contact the document owner for further details.',
          '',
          'SecureSign',
        ].filter(Boolean).join('\n'),
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#f9fafb;border-radius:12px">
            <div style="background:#dc2626;padding:20px 24px;border-radius:8px;margin-bottom:24px">
              <h1 style="color:#fff;margin:0;font-size:20px">❌ Signature Rejected</h1>
            </div>
            <p style="color:#111;margin:0 0 16px">Hi <strong>${sig.signer_name}</strong>,</p>
            <p style="color:#555;margin:0 0 24px">
              Your signature for <strong>"${docTitle}"</strong> has been rejected by the document owner.
            </p>
            ${rejection_reason ? `
              <div style="background:#fee;border:1px solid #fcc;border-radius:8px;padding:16px;margin-bottom:24px">
                <p style="color:#991;font-weight:600;margin:0 0 8px;font-size:13px">REJECTION REASON:</p>
                <p style="color:#555;margin:0;font-style:italic">"${rejection_reason}"</p>
              </div>
            ` : ''}
            <p style="color:#555;margin:0">
              Please contact the document owner for further details or clarification.
            </p>
            <p style="color:#9ca3af;font-size:12px;margin-top:32px;border-top:1px solid #e5e7eb;padding-top:16px">
              This is an automated notification from SecureSign.
            </p>
          </div>`,
      });

      console.log(`✅ Rejection email sent to ${sig.signer_email}`);
    }

    await supabaseAdmin.from('audit_logs').insert([{
      user_id:     userId,
      document_id: sig.document_id,
      action:      status === 'rejected' ? 'SIGNATURE_REJECTED' : 'SIGNATURE_SIGNED',
      details: {
        signature_id:     id,
        signer_name:      sig.signer_name,
        rejection_reason: status === 'rejected' ? rejection_reason : null,
        email_sent:       status === 'rejected' && notify_signer && sig.signer_email ? true : false,
      },
      ip_address: req.ip,
      user_agent: req.get('user-agent'),
    }]);

    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('updateSignatureStatus error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

const deleteSignature = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const { data: sig, error: sigErr } = await supabaseAdmin
      .from('signatures')
      .select('id, document_id')
      .eq('id', id)
      .single();

    if (sigErr || !sig) {
      return res.status(404).json({ success: false, error: 'Signature not found' });
    }

    const { data: doc, error: docErr } = await supabase
      .from('documents')
      .select('id')
      .eq('id', sig.document_id)
      .eq('user_id', userId)
      .single();

    if (docErr || !doc) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    const { error } = await supabaseAdmin
      .from('signatures')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to delete signature' });
    }

    res.json({ success: true, message: 'Signature deleted' });
  } catch (err) {
    console.error('deleteSignature error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

module.exports = {
  createSignature,
  getDocumentSignatures,
  updateSignaturePosition,
  updateSignatureStatus,
  deleteSignature,
};