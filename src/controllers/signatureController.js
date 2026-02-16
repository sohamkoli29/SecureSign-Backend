const supabase = require('../utils/supabase');
const supabaseAdmin = require('../utils/supabaseAdmin');
const { v4: uuidv4 } = require('uuid');
const createSignature = async (req, res) => {
  try {
    console.log('📝 Creating signature with data:', req.body);
    console.log('👤 User:', req.user);

    const { 
      document_id, 
      signer_name, 
      signer_email,
      coordinates, 
      page_number,
      signature_data
    } = req.body;

    const userId = req.user.id;

    // Validation
    if (!document_id) {
      return res.status(400).json({
        success: false,
        error: 'document_id is required'
      });
    }

    if (!signer_name) {
      return res.status(400).json({
        success: false,
        error: 'signer_name is required'
      });
    }

    // Verify document exists and belongs to user (use regular client)
    const { data: document, error: docError } = await supabase
      .from('documents')
      .select('id, user_id')
      .eq('id', document_id)
      .eq('user_id', userId)
      .single();

    if (docError || !document) {
      return res.status(404).json({
        success: false,
        error: 'Document not found or access denied'
      });
    }

    console.log('✅ Document verified:', document.id);

    // Prepare signature data
    const signatureData = {
      document_id,
      user_id: userId,
      signer_name,
      signer_email: signer_email || null,
      coordinates: coordinates || { x: 100, y: 100 },
      page_number: page_number || 1,
      status: signature_data ? 'signed' : 'pending',
      signature_data: signature_data || null,
      placed_at: new Date().toISOString()
    };

    if (signature_data) {
      signatureData.signed_at = new Date().toISOString();
    }

    console.log('📦 Inserting signature (using admin client)...');

    // ⭐ USE ADMIN CLIENT to bypass RLS
    const { data: signature, error: sigError } = await supabaseAdmin
      .from('signatures')
      .insert([signatureData])
      .select('*')
      .single();

    if (sigError) {
      console.error('❌ Insert error:', sigError);
      return res.status(500).json({
        success: false,
        error: 'Error creating signature',
        message: sigError.message
      });
    }

    console.log('✅ Signature created successfully:', signature.id);

    // Log audit trail (also use admin)
    await supabaseAdmin
      .from('audit_logs')
      .insert([{
        user_id: userId,
        document_id: document_id,
        action: signature_data ? 'SIGNATURE_ADDED' : 'SIGNATURE_PLACEHOLDER_CREATED',
        details: {
          signature_id: signature.id,
          signer_name: signer_name
        },
        ip_address: req.ip,
        user_agent: req.get('user-agent')
      }]);

    res.status(201).json({
      success: true,
      message: 'Signature created successfully',
      data: signature
    });

  } catch (error) {
    console.error('❌ Create signature error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: error.message
    });
  }
};
// @desc    Get all signatures for a document
// @route   GET /api/signatures/document/:documentId
// @access  Private
const getDocumentSignatures = async (req, res) => {
  try {
    const { documentId } = req.params;
    const userId = req.user.id;

    // Check document access (use regular client)
    const { data: document, error: docError } = await supabase
      .from('documents')
      .select('id')
      .eq('id', documentId)
      .eq('user_id', userId)
      .single();

    if (docError || !document) {
      return res.status(404).json({
        success: false,
        error: 'Document not found'
      });
    }

    // Get signatures (use admin)
    const { data: signatures, error } = await supabaseAdmin
      .from('signatures')
      .select('*')
      .eq('document_id', documentId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error fetching signatures:', error);
      return res.status(500).json({
        success: false,
        error: 'Error fetching signatures'
      });
    }

    res.json({
      success: true,
      data: signatures
    });

  } catch (error) {
    console.error('Get signatures error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
};

// @desc    Update signature position
// @route   PUT /api/signatures/:id/position
// @access  Private
const updateSignaturePosition = async (req, res) => {
  try {
    const { id } = req.params;
    const { coordinates, page_number } = req.body;
    const userId = req.user.id;

    // Check if signature exists and belongs to user's document (use admin)
    const { data: signature, error: checkError } = await supabaseAdmin
      .from('signatures')
      .select('*, documents!inner(user_id)')
      .eq('id', id)
      .single();

    if (checkError || !signature) {
      return res.status(404).json({
        success: false,
        error: 'Signature not found'
      });
    }

    // Verify user owns the document
    if (signature.documents.user_id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    // Update position (use admin)
    const { data: updated, error: updateError } = await supabaseAdmin
      .from('signatures')
      .update({
        coordinates,
        page_number: page_number || signature.page_number,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select('*')
      .single();

    if (updateError) {
      console.error('Error updating signature:', updateError);
      return res.status(500).json({
        success: false,
        error: 'Error updating signature position'
      });
    }

    res.json({
      success: true,
      message: 'Signature position updated',
      data: updated
    });

  } catch (error) {
    console.error('Update position error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
};


// @desc    Delete signature placeholder
// @route   DELETE /api/signatures/:id
const deleteSignature = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Check signature (use admin)
    const { data: signature, error: checkError } = await supabaseAdmin
      .from('signatures')
      .select('*, documents!inner(user_id)')
      .eq('id', id)
      .single();

    if (checkError || !signature) {
      return res.status(404).json({
        success: false,
        error: 'Signature not found'
      });
    }

    // Verify access
    if (signature.documents.user_id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    // Delete signature (use admin)
    const { error: deleteError } = await supabaseAdmin
      .from('signatures')
      .delete()
      .eq('id', id);

    if (deleteError) {
      console.error('Error deleting signature:', deleteError);
      return res.status(500).json({
        success: false,
        error: 'Error deleting signature'
      });
    }

    res.json({
      success: true,
      message: 'Signature deleted successfully'
    });

  } catch (error) {
    console.error('Delete signature error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
};

// @desc    Update signature status
// @route   PATCH /api/signatures/:id/status
// @access  Private
const updateSignatureStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, rejection_reason, signature_data } = req.body;
    const userId = req.user.id;

    // Check signature (use admin)
    const { data: signature, error: checkError } = await supabaseAdmin
      .from('signatures')
      .select('*, documents!inner(user_id)')
      .eq('id', id)
      .single();

    if (checkError || !signature) {
      return res.status(404).json({
        success: false,
        error: 'Signature not found'
      });
    }

    // Verify access
    if (signature.documents.user_id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const updateData = {
      status,
      updated_at: new Date().toISOString()
    };

    if (status === 'signed') {
      updateData.signed_at = new Date().toISOString();
      if (signature_data) {
        updateData.signature_data = signature_data;
      }
    } else if (status === 'rejected' && rejection_reason) {
      updateData.rejection_reason = rejection_reason;
    }

    // Update status (use admin)
    const { data: updated, error: updateError } = await supabaseAdmin
      .from('signatures')
      .update(updateData)
      .eq('id', id)
      .select('*')
      .single();

    if (updateError) {
      console.error('Error updating signature status:', updateError);
      return res.status(500).json({
        success: false,
        error: 'Error updating signature status'
      });
    }

    // Check if all signatures are signed
    if (status === 'signed') {
      const { data: allSignatures } = await supabaseAdmin
        .from('signatures')
        .select('status')
        .eq('document_id', signature.document_id);

      const allSigned = allSignatures.every(s => s.status === 'signed');
      
      if (allSigned) {
        await supabaseAdmin
          .from('documents')
          .update({
            status: 'signed',
            last_signed_at: new Date().toISOString()
          })
          .eq('id', signature.document_id);
      }
    }

    res.json({
      success: true,
      message: `Signature ${status}`,
      data: updated
    });

  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
};


module.exports = {
  createSignature,
  getDocumentSignatures,
  updateSignaturePosition,
  deleteSignature,
  updateSignatureStatus
};