const supabaseAdmin = require('../utils/supabaseAdmin');
const nodemailer    = require('nodemailer');
const { v4: uuidv4 } = require('uuid');

/* ── Email transporter ───────────────────────────────────────────── */
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

  // Mock transporter for development
  return {
    sendMail: async (opts) => {
      console.log('\n📧 ── MOCK EMAIL ──────────────────────────────');
      console.log(`  To:      ${opts.to}`);
      console.log(`  Subject: ${opts.subject}`);
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
 * Generates signing token, sends email notification
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
        link_sent:        true,  // lock position after sending
        updated_at:       new Date().toISOString(),
      })
      .eq('id', id);

    if (updateErr) {
      console.error('sendSigningLink update error:', updateErr);
      return res.status(500).json({ success: false, error: 'Failed to generate signing link' });
    }

    const docTitle = doc.title || 'Document';
    const publicUrl = `${process.env.FRONTEND_URL}/sign/public/${token}`;

    /* ── Send email if email provided ────────────────────────────────── */
    if (signer_email?.trim()) {
      const transporter = getTransporter();

      await transporter.sendMail({
        from:    process.env.GMAIL_USER || 'noreply@SecureSign.app',
        to:      signer_email.trim(),
        subject: `Please sign: ${docTitle}`,
        text: [
          `Hi ${signer_name},`,
          '',
          `You have been requested to sign "${docTitle}".`,
          '',
          `Click the link below to review and sign:`,
          publicUrl,
          '',
          `This link expires on ${expiresAt.toDateString()}.`,
          '',
          'SecureSign',
        ].join('\n'),
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#f9fafb;border-radius:12px">
            <div style="background:#2563eb;padding:20px 24px;border-radius:8px;margin-bottom:24px">
              <h1 style="color:#fff;margin:0;font-size:20px"><img 
  src="${process.env.LOGO_URL}"
  alt="SecureSign"
  style="height:32px; display:block;"
/>
 Signature Request</h1>
            </div>
            <p style="color:#111;margin:0 0 8px">Hi <strong>${signer_name}</strong>,</p>
            <p style="color:#555;margin:0 0 24px">
              You have been requested to sign <strong>"${docTitle}"</strong>.
            </p>
            <div style="text-align:center;margin-bottom:24px">
              <a href="${publicUrl}" style="display:inline-block;padding:14px 32px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px">
                Review & Sign Document
              </a>
            </div>
            <div style="background:#dbeafe;border:1px solid #93c5fd;border-radius:8px;padding:16px;margin-bottom:24px">
              <p style="color:#1e3a8a;font-weight:600;margin:0 0 8px;font-size:13px">⏱ EXPIRES:</p>
              <p style="color:#1e40af;margin:0">${expiresAt.toDateString()} (7 days)</p>
            </div>
            <p style="color:#9ca3af;font-size:12px;margin-top:32px;border-top:1px solid #e5e7eb;padding-top:16px">
              If you did not expect this request, please ignore this email.
            </p>
          </div>`,
      });

      console.log(`✅ Signing link sent to ${signer_email}`);
    }

    /* ── Audit log ───────────────────────────────────────────────────── */
    await supabaseAdmin.from('audit_logs').insert([{
      user_id:     userId,
      document_id: sig.document_id,
      action:      'SIGNING_LINK_SENT',
      details: {
        signature_id: id,
        signer_name:  signer_name.trim(),
        signer_email: signer_email?.trim() || null,
        expires_at:   expiresAt.toISOString(),
      },
      ip_address: req.ip,
      user_agent: req.get('user-agent'),
    }]);

    res.json({
      success:    true,
      public_url: publicUrl,
      expires_at: expiresAt.toISOString(),
    });

  } catch (err) {
    console.error('sendSigningLink error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

/**
 * GET /api/signatures/public/:token
 * NO auth required
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

    // Fetch document separately
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
 * 1. Marks signature as signed
 * 2. Checks if all signatures signed → auto-finalize PDF
 * 3. Emails signed PDF to signer
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
      .select('id, status, document_id, signer_name, signer_email, token_expires_at')
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

    /* ── Mark as signed ──────────────────────────────────────────────── */
    const { error: updateErr } = await supabaseAdmin
      .from('signatures')
      .update({
        status:           'signed',
        signature_data,
        signing_token:    null,
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

    /* ── Check if all signed → auto-finalize ─────────────────────────── */
    const { data: allSigs } = await supabaseAdmin
      .from('signatures')
      .select('id, status')
      .eq('document_id', sig.document_id);

    const allSigned = allSigs?.every(s => s.status === 'signed');
    let signedPdfUrl = null;

    if (allSigned) {
      try {
        const { PDFDocument } = require('pdf-lib');
        const axios = require('axios');

        const { data: doc } = await supabaseAdmin
          .from('documents')
          .select('id, file_url, file_name, title')
          .eq('id', sig.document_id)
          .single();

        if (doc?.file_url) {
          const pdfResponse = await axios.get(doc.file_url, { responseType: 'arraybuffer' });
          const pdfDoc = await PDFDocument.load(pdfResponse.data);

          const { data: signatures } = await supabaseAdmin
            .from('signatures')
            .select('*')
            .eq('document_id', sig.document_id)
            .eq('status', 'signed');

          for (const signature of signatures) {
            if (!signature.signature_data || !signature.coordinates) continue;

            const page = pdfDoc.getPages()[signature.page_number - 1];
            if (!page) continue;

            const { width: pageWidth, height: pageHeight } = page.getSize();
            const base64Data = signature.signature_data.split(',')[1];
            const pngBytes = Buffer.from(base64Data, 'base64');
            const embedded = await pdfDoc.embedPng(pngBytes);

            const sigW = signature.coordinates.width || 220;
            const sigH = signature.coordinates.height || 110;
            const browserX = signature.coordinates.x ?? 0;
            const browserY = signature.coordinates.y ?? 0;

            const pdfX = Math.max(0, Math.min(browserX, pageWidth - sigW));
            const pdfY = pageHeight - Math.max(0, Math.min(browserY, pageHeight - sigH)) - sigH;

            page.drawImage(embedded, { x: pdfX, y: pdfY, width: sigW, height: sigH });
          }

          const finalizedBytes = await pdfDoc.save();
          const timestamp = Date.now();
          const fileName = `signed-${timestamp}-${doc.file_name}`;

          const { data: uploadData, error: uploadErr } = await supabaseAdmin.storage
            .from('documents')
            .upload(`signed/${fileName}`, Buffer.from(finalizedBytes), {
              contentType: 'application/pdf',
              upsert: false,
            });

          if (!uploadErr && uploadData) {
            const { data: urlData } = supabaseAdmin.storage
              .from('documents')
              .getPublicUrl(`signed/${fileName}`);

            signedPdfUrl = urlData.publicUrl;

            await supabaseAdmin
              .from('documents')
              .update({ signed_file_url: signedPdfUrl, status: 'signed' })
              .eq('id', sig.document_id);

            console.log(`✅ Auto-finalized: ${signedPdfUrl}`);
          }
        }
      } catch (finalizeErr) {
        console.error('Auto-finalize error:', finalizeErr);
      }
    }

    /* ── Email signed PDF to signer ──────────────────────────────────── */
    if (signedPdfUrl && sig.signer_email) {
      const transporter = getTransporter();

      const { data: doc } = await supabaseAdmin
        .from('documents')
        .select('title, file_name')
        .eq('id', sig.document_id)
        .single();

      const docTitle = doc?.title || doc?.file_name || 'Document';

      await transporter.sendMail({
        from: process.env.GMAIL_USER || 'noreply@SecureSign.app',
        to: sig.signer_email,
        subject: `Signed: ${docTitle}`,
        text: [
          `Hi ${sig.signer_name},`,
          '',
          `Thank you for signing "${docTitle}".`,
          '',
          `Download your signed copy: ${signedPdfUrl}`,
          '',
          'SecureSign',
        ].join('\n'),
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#f9fafb;border-radius:12px">
            <div style="background:#10b981;padding:20px 24px;border-radius:8px;margin-bottom:24px">
              <h1 style="color:#fff;margin:0;font-size:20px"> <img 
  src="${process.env.LOGO_URL}"
  alt="SecureSign"
  style="height:32px; display:block;"
/>
 Document Signed</h1>
            </div>
            <p style="color:#111;margin:0 0 16px">Hi <strong>${sig.signer_name}</strong>,</p>
            <p style="color:#555;margin:0 0 24px">Thank you for signing <strong>"${docTitle}"</strong>.</p>
            <div style="text-align:center;margin-bottom:24px">
              <a href="${signedPdfUrl}" style="display:inline-block;padding:14px 32px;background:#10b981;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">
                Download Signed PDF
              </a>
            </div>
            <p style="color:#9ca3af;font-size:12px;margin-top:32px;border-top:1px solid #e5e7eb;padding-top:16px">
              This is an automated notification from SecureSign.
            </p>
          </div>`,
      });

      console.log(`✅ Signed PDF emailed to ${sig.signer_email}`);
    }

    /* ── Audit log ───────────────────────────────────────────────────── */
    await supabaseAdmin.from('audit_logs').insert([{
      user_id: null,
      document_id: sig.document_id,
      action: 'PUBLIC_SIGNATURE_SUBMITTED',
      details: {
        signature_id: sig.id,
        signer_name: sig.signer_name,
        all_signed: allSigned,
        pdf_emailed: !!signedPdfUrl,
      },
      ip_address: req.ip,
      user_agent: req.get('user-agent'),
    }]);

    res.json({
      success: true,
      message: 'Document signed successfully',
      signer_name: sig.signer_name,
      pdf_ready: allSigned,
    });

  } catch (err) {
    console.error('submitPublicSignature error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

/**
 * POST /api/signatures/public/:token/reject
 * NO auth required
 */
const submitPublicRejection = async (req, res) => {
  try {
    const { token }            = req.params;
    const { rejection_reason } = req.body;

    if (!rejection_reason?.trim()) {
      return res.status(400).json({ success: false, error: 'rejection_reason is required' });
    }

    const { data: sig, error } = await supabaseAdmin
      .from('signatures')
      .select('id, status, document_id, signer_name, signer_email, token_expires_at')
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

    if (sig.status === 'rejected') {
      return res.status(400).json({ success: false, error: 'Already rejected' });
    }

    const { error: updateErr } = await supabaseAdmin
      .from('signatures')
      .update({
        status:           'rejected',
        rejection_reason: rejection_reason.trim(),
        signing_token:    null,
        token_expires_at: null,
        signer_ip:        req.ip,
        updated_at:       new Date().toISOString(),
      })
      .eq('id', sig.id);

    if (updateErr) {
      console.error('submitPublicRejection update error:', updateErr);
      return res.status(500).json({ success: false, error: 'Failed to save rejection' });
    }

    const { data: doc, error: docErr } = await supabaseAdmin
      .from('documents')
      .select('id, title, file_name, user_id, users(email, full_name)')
      .eq('id', sig.document_id)
      .single();

    if (docErr || !doc) {
      console.error('Failed to fetch document for rejection email:', docErr);
      return res.json({ success: true, message: 'Signature rejected' });
    }

    const ownerEmail = doc.users?.email;
    const ownerName  = doc.users?.full_name || 'Document Owner';
    const docTitle   = doc.title || doc.file_name || 'Document';

    if (ownerEmail) {
      const transporter = getTransporter();

      await transporter.sendMail({
        from:    process.env.GMAIL_USER || 'noreply@SecureSign.app',
        to:      ownerEmail,
        subject: `Signature Rejected: ${docTitle}`,
        text: [
          `Hi ${ownerName},`,
          '',
          `${sig.signer_name} has rejected the signing request for "${docTitle}".`,
          '',
          `Reason: ${rejection_reason.trim()}`,
          '',
          'SecureSign',
        ].join('\n'),
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#f9fafb;border-radius:12px">
            <div style="background:#dc2626;padding:20px 24px;border-radius:8px;margin-bottom:24px">
              <h1 style="color:#fff;margin:0;font-size:20px">❌ Signature Rejected</h1>
            </div>
            <p style="color:#111;margin:0 0 8px">Hi <strong>${ownerName}</strong>,</p>
            <p style="color:#555;margin:0 0 24px">
              <strong>${sig.signer_name}</strong> has rejected the signing request for <strong>"${docTitle}"</strong>.
            </p>
            <div style="background:#fee;border:1px solid #fcc;border-radius:8px;padding:16px;margin-bottom:24px">
              <p style="color:#991;font-weight:600;margin:0 0 8px;font-size:13px">REJECTION REASON:</p>
              <p style="color:#555;margin:0;font-style:italic">"${rejection_reason.trim()}"</p>
            </div>
            <p style="color:#9ca3af;font-size:12px;margin-top:32px;border-top:1px solid #e5e7eb;padding-top:16px">
              This is an automated notification from SecureSign.
            </p>
          </div>`,
      });

      console.log(`✅ Rejection notification sent to ${ownerEmail}`);
    }

    await supabaseAdmin.from('audit_logs').insert([{
      user_id:     null,
      document_id: sig.document_id,
      action:      'PUBLIC_SIGNATURE_REJECTED',
      details: {
        signature_id:     sig.id,
        signer_name:      sig.signer_name,
        rejection_reason: rejection_reason.trim(),
        email_sent:       !!ownerEmail,
      },
      ip_address: req.ip,
      user_agent: req.get('user-agent'),
    }]);

    res.json({
      success:     true,
      message:     'Signature rejected',
      signer_name: sig.signer_name,
    });

  } catch (err) {
    console.error('submitPublicRejection error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

module.exports = {
  sendSigningLink,
  getPublicSigningRequest,
  submitPublicSignature,
  submitPublicRejection,
};