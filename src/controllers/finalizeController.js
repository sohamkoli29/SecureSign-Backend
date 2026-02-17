const { PDFDocument } = require('pdf-lib');
const supabase        = require('../utils/supabase');
const supabaseAdmin   = require('../utils/supabaseAdmin');
const { v4: uuidv4 }  = require('uuid');

/**
 * POST /api/documents/:id/finalize
 *
 * Coordinate system explained:
 * ─────────────────────────────
 * react-pdf renders at scale=1.0 → 1 CSS pixel = 1 PDF point exactly.
 * So the x,y stored in the DB (CSS pixels relative to page top-left)
 * map 1:1 to PDF points — NO DPI scaling needed on coordinates.
 *
 * pdf-lib origin is BOTTOM-LEFT, browser origin is TOP-LEFT.
 * Flip:  pdfY = pageHeight - browserY - sigH
 *
 * The signature is always displayed at SIG_W × SIG_H pixels in the browser
 * (fixed size set in PDFViewer.jsx). We embed it at the same size in points.
 *
 * If the user zoomed the PDF (scale ≠ 1), the stored coordinates are still
 * in page-space because PDFViewer clamps to wrapperRef which scales with the
 * page — but the stored coords must be divided by the render scale to get
 * true page-space points. We store scale=1 coords (PDFViewer default), so
 * no correction is needed as long as scale stays at 1 when coordinates are saved.
 */

const SIG_W = 220; // must match PDFViewer.jsx SIG_W constant
const SIG_H = 110; // must match PDFViewer.jsx SIG_H constant

const finalizeDocument = async (req, res) => {
  try {
    const { id }  = req.params;
    const userId  = req.user.id;

    console.log(`📄 Finalizing document ${id} for user ${userId}`);

    /* ── 1. Load document ─────────────────────────────────────── */
    const { data: doc, error: docError } = await supabase
      .from('documents')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (docError || !doc) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }

    /* ── 2. Fetch signed signatures ───────────────────────────── */
    const { data: signatures, error: sigError } = await supabaseAdmin
      .from('signatures')
      .select('*')
      .eq('document_id', id)
      .eq('status', 'signed')
      .not('signature_data', 'is', null);

    if (sigError) {
      return res.status(500).json({ success: false, error: 'Failed to fetch signatures' });
    }

    if (!signatures || signatures.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No signed signatures found. Sign at least one field before finalizing.',
      });
    }

    console.log(`✅ ${signatures.length} signed signature(s) found`);

    /* ── 3. Download original PDF ─────────────────────────────── */
    const { data: fileData, error: downloadError } = await supabaseAdmin
      .storage
      .from('documents')
      .download(doc.file_path);

    if (downloadError || !fileData) {
      console.error('Download error:', downloadError);
      return res.status(500).json({ success: false, error: 'Failed to download original PDF' });
    }

    const originalPdfBytes = await fileData.arrayBuffer();
    console.log(`📥 Original PDF: ${(originalPdfBytes.byteLength / 1024).toFixed(1)} KB`);

    /* ── 4. Load PDF ──────────────────────────────────────────── */
    const pdfDoc = await PDFDocument.load(originalPdfBytes);
    const pages  = pdfDoc.getPages();

    console.log(`📑 ${pages.length} page(s)`);

    /* ── 5. Embed each signature ──────────────────────────────── */
    for (const sig of signatures) {
      const pageIndex = (sig.page_number || 1) - 1;
      const page      = pages[pageIndex];

      if (!page) {
        console.warn(`⚠️  Page ${sig.page_number} not found — skipping`);
        continue;
      }

      const { width: pageWidth, height: pageHeight } = page.getSize();

      // Decode base64 PNG
      const base64Data = sig.signature_data.split(',')[1];
      const pngBytes   = Buffer.from(base64Data, 'base64');
      const embedded   = await pdfDoc.embedPng(pngBytes);

      /*
        Coordinate conversion
        ─────────────────────
        Browser (react-pdf scale=1): origin = top-left,  1px = 1pt
        pdf-lib:                     origin = bottom-left, units = pt

        browserX, browserY  = top-left of the 220×110 signature box
        sigW, sigH          = fixed display size (same in browser & PDF)

        pdfX = browserX                          (x is same axis)
        pdfY = pageHeight - browserY - sigH      (flip Y axis)
      */
      const browserX = sig.coordinates?.x ?? 0;
      const browserY = sig.coordinates?.y ?? 0;

      // Clamp so signature never exceeds page bounds
      const clampedX = Math.max(0, Math.min(browserX, pageWidth  - SIG_W));
      const clampedY = Math.max(0, Math.min(browserY, pageHeight - SIG_H));

      const pdfX = clampedX;
      const pdfY = pageHeight - clampedY - SIG_H;  // Y-axis flip

      console.log(
        `🖊  Page ${sig.page_number} | ` +
        `pageSize=${pageWidth.toFixed(0)}×${pageHeight.toFixed(0)}pt | ` +
        `browser(${browserX.toFixed(0)},${browserY.toFixed(0)}) → ` +
        `pdf(${pdfX.toFixed(0)},${pdfY.toFixed(0)}) | ` +
        `size=${SIG_W}×${SIG_H}pt`
      );

      page.drawImage(embedded, {
        x:      pdfX,
        y:      pdfY,
        width:  SIG_W,
        height: SIG_H,
      });
    }

    /* ── 6. Save PDF ──────────────────────────────────────────── */
    const signedPdfBytes = await pdfDoc.save();
    console.log(`💾 Signed PDF: ${(signedPdfBytes.byteLength / 1024).toFixed(1)} KB`);

    /* ── 7. Upload to Supabase ────────────────────────────────── */
    const signedFileName = `signed-${uuidv4()}.pdf`;

    const { error: uploadError } = await supabaseAdmin
      .storage
      .from('documents')
      .upload(signedFileName, signedPdfBytes, {
        contentType:  'application/pdf',
        cacheControl: '3600',
        upsert:       false,
      });

    if (uploadError) {
      console.error('Upload error:', uploadError);
      return res.status(500).json({ success: false, error: 'Failed to upload signed PDF' });
    }

    console.log(`📤 Uploaded as: ${signedFileName}`);

    /* ── 8. Public URL ────────────────────────────────────────── */
    const { data: urlData } = supabase
      .storage
      .from('documents')
      .getPublicUrl(signedFileName);

    const signedFileUrl = urlData.publicUrl;

    /* ── 9. Update document record ────────────────────────────── */
    const { data: updatedDoc } = await supabase
      .from('documents')
      .update({
        status:           'signed',
        signed_file_path: signedFileName,
        signed_file_url:  signedFileUrl,
        finalized_at:     new Date().toISOString(),
        updated_at:       new Date().toISOString(),
      })
      .eq('id', id)
      .eq('user_id', userId)
      .select('*')
      .single();

    /* ── 10. Audit log ────────────────────────────────────────── */
    await supabaseAdmin
      .from('audit_logs')
      .insert([{
        user_id:     userId,
        document_id: id,
        action:      'DOCUMENT_FINALIZED',
        details: {
          signatures_embedded: signatures.length,
          signed_file_path:    signedFileName,
          original_size_kb:    Math.round(originalPdfBytes.byteLength / 1024),
          signed_size_kb:      Math.round(signedPdfBytes.byteLength   / 1024),
        },
        ip_address: req.ip,
        user_agent: req.get('user-agent'),
      }]);

    console.log(`✅ Document ${id} finalized`);

    res.json({
      success: true,
      message: `Finalized with ${signatures.length} signature(s)`,
      data: {
        document:            updatedDoc || { id, status: 'signed' },
        signed_file_url:     signedFileUrl,
        signatures_embedded: signatures.length,
      },
    });

  } catch (error) {
    console.error('❌ finalizeDocument error:', error);
    res.status(500).json({
      success: false,
      error:   'Server error during finalization',
      message: error.message,
    });
  }
};

module.exports = { finalizeDocument };