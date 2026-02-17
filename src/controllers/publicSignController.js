const { v4: uuidv4 } = require('uuid');
const supabase       = require('../utils/supabase');
const supabaseAdmin  = require('../utils/supabaseAdmin');
const nodemailer     = require('nodemailer');

/* ── Email transporter (Gmail SMTP or console fallback) ─────────── */
const getTransporter = () => {
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
  }
  // Mock transporter — logs to console
  return {
    sendMail: async (opts) => {
      console.log('\n📧 ── MOCK EMAIL ──────────────────────────────');
      console.log(`  To:      ${opts.to}`);
      console.log(`  Subject: ${opts.subject}`);
      console.log(`  Link:    ${opts.text?.match(/https?:\/\/\S+/)?.[0] || '(see html)'}`);
      console.log('─────────────────────────────────────────────\n');
      return { messageId: 'mock-' + Date.now() };
    },
  };
};

/**
 * POST /api/signatures/:id/send-link
 * Auth required (document owner only)
 *
 * Body: { signer_name, signer_email }
 *
 * Generates a UUID token on the signature row, returns the public URL,
 * and optionally emails it to the signer.
 */
const sendSigningLink = async (req, res) => {
  try {
    const { id }                       = req.params;
    const { signer_name, signer_email } = req.body;
    const userId                        = req.user.id;

    if (!signer_name?.trim()) {
      return res.status(400).json({ success: false, error: 'signer_name is required' });
    }

    /* ── Verify signature exists ─────────────────────────────────────── */
    const { data: sig, error: sigErr } = await supabaseAdmin
      .from('signatures')
      .select('id, document_id, status, signer_name, signer_email')
      .eq('id', id)
      .single();

    if (sigErr || !sig) {
      return res.status(404).json({ success: false, error: 'Signature not found' });
    }

    /* ── Verify the document is owned by this user ───────────────────── */
    const { data: doc, error: docErr } = await supabaseAdmin
      .from('documents')
      .select('id, title, user_id, file_url')
      .eq('id', sig.document_id)
      .single();

    if (docErr || !doc) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }

    if (doc.user_id !== userId) {
      return res.status(403).json({ success: false, error: 'Not authorised' });
    }

    if (sig.status === 'signed') {
      return res.status(400).json({ success: false, error: 'This signature has already been signed' });
    }

    /* ── Generate token ──────────────────────────────────────────────── */
    const token      = uuidv4();
    const expiresAt  = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const { error: updateErr } = await supabaseAdmin
      .from('signatures')
      .update({
        signing_token:    token,
        token_expires_at: expiresAt.toISOString(),
        signer_name:      signer_name.trim(),
        signer_email:     signer_email?.trim() || null,
        updated_at:       new Date().toISOString(),
      })
      .eq('id', id);

    if (updateErr) {
      console.error('Token update error:', updateErr);
      return res.status(500).json({ success: false, error: 'Failed to generate signing link' });
    }

    /* ── Build public URL ────────────────────────────────────────────── */
    const frontendUrl  = process.env.FRONTEND_URL || 'http://localhost:5173';
    const publicUrl    = `${frontendUrl}/sign/public/${token}`;
    const docTitle = doc.title || 'Document';

    /* ── Send email (or mock) ────────────────────────────────────────── */
    if (signer_email?.trim()) {
      const transporter = getTransporter();
      await transporter.sendMail({
        from:    process.env.GMAIL_USER || 'noreply@docsign.app',
        to:      signer_email.trim(),
        subject: `You've been asked to sign: ${docTitle}`,
        text: [
          `Hi ${signer_name},`,
          '',
          `You have been requested to sign the document "${docTitle}".`,
          '',
          `Click the link below to review and sign:`,
          publicUrl,
          '',
          `This link expires on ${expiresAt.toLocaleDateString()}.`,
          '',
          'DocSign',
        ].join('\n'),
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#f9fafb;border-radius:12px">
            <div style="background:#1e3a5f;padding:20px 24px;border-radius:8px;margin-bottom:24px">
              <h1 style="color:#fff;margin:0;font-size:20px">📄 DocSign</h1>
            </div>
            <h2 style="color:#111;font-size:18px;margin:0 0 8px">Signature Requested</h2>
            <p style="color:#555;margin:0 0 24px">Hi <strong>${signer_name}</strong>, you have been asked to sign:</p>
            <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:24px">
              <p style="color:#111;font-weight:600;margin:0">${docTitle}</p>
            </div>
            <a href="${publicUrl}"
               style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">
              Review &amp; Sign Document →
            </a>
            <p style="color:#9ca3af;font-size:12px;margin-top:32px">
              This link expires on ${expiresAt.toLocaleDateString()}.
              If you did not expect this request, please ignore this email.
            </p>
          </div>`,
      });
    }

    /* ── Audit log ───────────────────────────────────────────────────── */
    await supabaseAdmin.from('audit_logs').insert([{
      user_id:     userId,
      document_id: sig.document_id,
      action:      'SIGNING_LINK_SENT',
      details: {
        signature_id: id,
        signer_name,
        signer_email:  signer_email || null,
        expires_at:    expiresAt.toISOString(),
        email_sent:    !!signer_email,
      },
      ip_address: req.ip,
      user_agent: req.get('user-agent'),
    }]);

    res.json({
      success:     true,
      public_url:  publicUrl,
      expires_at:  expiresAt.toISOString(),
      email_sent:  !!(signer_email?.trim()),
      message:     signer_email
        ? `Signing link sent to ${signer_email}`
        : 'Signing link generated (no email address provided)',
    });

  } catch (err) {
    console.error('sendSigningLink error:', err);
    res.status(500).json({ success: false, error: 'Server error', message: err.message });
  }
};

/**
 * GET /api/signatures/public/:token
 * NO auth required
 *
 * Returns the document info + signature placeholder so the
 * PublicSignPage can render the PDF and know where to sign.
 */
const getPublicSigningRequest = async (req, res) => {
  try {
    const { token } = req.params;

    const { data: sig, error } = await supabaseAdmin
      .from('signatures')
      .select('id, status, signer_name, signer_email, coordinates, page_number, token_expires_at, document_id')
      .eq('signing_token', token)
      .single();

    if (error || !sig) {
      return res.status(404).json({ success: false, error: 'Invalid or expired signing link' });
    }

    if (new Date(sig.token_expires_at) < new Date()) {
      return res.status(410).json({ success: false, error: 'This signing link has expired' });
    }

    if (sig.status === 'signed') {
      return res.status(200).json({
        success:        true,
        already_signed: true,
        message:        'This document has already been signed',
        signer_name:    sig.signer_name,
      });
    }

    // Fetch document separately — avoids RLS join issues
    const { data: doc, error: docErr } = await supabaseAdmin
      .from('documents')
      .select('id, title, file_url, file_name')
      .eq('id', sig.document_id)
      .single();

    if (docErr || !doc) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }

    res.json({
      success:        true,
      already_signed: false,
      signature: {
        id:          sig.id,
        signer_name: sig.signer_name,
        coordinates: sig.coordinates,
        page_number: sig.page_number,
        expires_at:  sig.token_expires_at,
      },
      document: {
        id:        doc.id,
        title:     doc.title,
        file_url:  doc.file_url,
        file_name: doc.file_name,
      },
    });

  } catch (err) {
    console.error('getPublicSigningRequest error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

/**
 * POST /api/signatures/public/:token/sign
 * NO auth required
 *
 * Body: { signature_data }  (base64 PNG)
 * Marks signature as signed, clears the token.
 */
const submitPublicSignature = async (req, res) => {
  try {
    const { token }          = req.params;
    const { signature_data } = req.body;

    if (!signature_data) {
      return res.status(400).json({ success: false, error: 'signature_data is required' });
    }

    /* ── Look up token ───────────────────────────────────────────────── */
    const { data: sig, error } = await supabaseAdmin
      .from('signatures')
      .select('id, status, document_id, signer_name, token_expires_at')
      .eq('signing_token', token)
      .single();

    if (error || !sig) {
      return res.status(404).json({ success: false, error: 'Invalid signing link' });
    }

    if (new Date(sig.token_expires_at) < new Date()) {
      return res.status(410).json({ success: false, error: 'This signing link has expired' });
    }

    if (sig.status === 'signed') {
      return res.status(400).json({ success: false, error: 'Already signed' });
    }

    /* ── Mark as signed, clear token ────────────────────────────────── */
    const { error: updateErr } = await supabaseAdmin
      .from('signatures')
      .update({
        status:           'signed',
        signature_data,
        signing_token:    null,    // invalidate link immediately
        token_expires_at: null,
        signer_ip:        req.ip,
        signed_at:        new Date().toISOString(),
        updated_at:       new Date().toISOString(),
      })
      .eq('id', sig.id);

    if (updateErr) {
      console.error('submitPublicSignature update error:', updateErr);
      return res.status(500).json({ success: false, error: 'Failed to save signature' });
    }

    /* ── Audit log ───────────────────────────────────────────────────── */
    await supabaseAdmin.from('audit_logs').insert([{
      user_id:     null,            // external signer has no account
      document_id: sig.document_id,
      action:      'PUBLIC_SIGNATURE_SUBMITTED',
      details: {
        signature_id: sig.id,
        signer_name:  sig.signer_name,
      },
      ip_address: req.ip,
      user_agent: req.get('user-agent'),
    }]);

    res.json({
      success:     true,
      message:     'Document signed successfully',
      signer_name: sig.signer_name,
    });

  } catch (err) {
    console.error('submitPublicSignature error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

module.exports = {
  sendSigningLink,
  getPublicSigningRequest,
  submitPublicSignature,
};