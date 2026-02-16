const supabase = require('../utils/supabase');
const supabaseAdmin = require('../utils/supabaseAdmin');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// @desc    Upload a new document (using admin client to bypass RLS)
const uploadDocument = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Please upload a file'
      });
    }

    const { title, description } = req.body;
    const userId = req.user.id;
    const file = req.file;

    console.log('📄 File received:', {
      name: file.originalname,
      size: `${(file.size / 1024).toFixed(2)} KB`,
      type: file.mimetype
    });

    // Read file
    const fileContent = fs.readFileSync(file.path);
    
    // Create unique filename
    const timestamp = Date.now();
    const uniqueId = uuidv4();
    const fileExtension = path.extname(file.originalname);
    const fileName = `${timestamp}-${uniqueId}${fileExtension}`;
    
    console.log('📤 Uploading to Supabase Storage...', { fileName });

    // Use admin client for upload (bypasses RLS completely)
    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from('documents')
      .upload(fileName, fileContent, {
        contentType: 'application/pdf',
        cacheControl: '3600',
        upsert: false
      });

    if (uploadError) {
      console.error('❌ Supabase upload error:', uploadError);
      fs.unlinkSync(file.path);
      
      // Check if bucket exists
      const { data: buckets } = await supabaseAdmin.storage.listBuckets();
      const documentsBucket = buckets?.find(b => b.name === 'documents');
      
      if (!documentsBucket) {
        return res.status(500).json({
          success: false,
          error: 'Documents bucket does not exist. Please create it in Supabase dashboard.'
        });
      }
      
      return res.status(500).json({
        success: false,
        error: `Upload failed: ${uploadError.message}`
      });
    }

    console.log('✅ File uploaded to storage');

    // Get public URL (can use regular client for this)
    const { data: urlData } = supabase
      .storage
      .from('documents')
      .getPublicUrl(fileName);

    const publicUrl = urlData.publicUrl;

    console.log('🔗 Public URL:', publicUrl);

    // Save document metadata to database
    const documentTitle = title || path.parse(file.originalname).name;
    
    const { data: document, error: dbError } = await supabase
      .from('documents')
      .insert([
        {
          user_id: userId,
          title: documentTitle,
          description: description || '',
          file_name: file.originalname,
          file_path: fileName,
          file_url: publicUrl,
          file_size: file.size,
          mime_type: file.mimetype,
          status: 'pending'
        }
      ])
      .select('*')
      .single();

    if (dbError) {
      console.error('❌ Database error:', dbError);
      
      // Clean up storage
      await supabaseAdmin.storage.from('documents').remove([fileName]);
      fs.unlinkSync(file.path);
      
      return res.status(500).json({
        success: false,
        error: `Database error: ${dbError.message}`
      });
    }

    // Clean up local file
    fs.unlinkSync(file.path);

    // Log in audit trail
    await supabase
      .from('audit_logs')
      .insert([
        {
          user_id: userId,
          action: 'DOCUMENT_UPLOADED',
          details: {
            document_id: document.id,
            title: documentTitle,
            file_name: file.originalname,
            file_size: file.size
          },
          ip_address: req.ip,
          user_agent: req.get('user-agent')
        }
      ]);

    console.log('✅ Document saved to database:', document.id);

    res.status(201).json({
      success: true,
      message: 'Document uploaded successfully',
      data: document
    });

  } catch (error) {
    console.error('❌ Upload error:', error);
    
    // Clean up local file if it exists
    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {
        console.error('Error cleaning up file:', e);
      }
    }

    res.status(500).json({
      success: false,
      error: `Server error: ${error.message}`
    });
  }
};

// @desc    Get all documents for current user
const getDocuments = async (req, res) => {
  try {
    const userId = req.user.id;
    const { status, page = 1, limit = 10 } = req.query;

    let query = supabase
      .from('documents')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    const start = (page - 1) * limit;
    const end = start + limit - 1;
    query = query.range(start, end);

    const { data: documents, error, count } = await query;

    if (error) {
      console.error('Error fetching documents:', error);
      return res.status(500).json({
        success: false,
        error: 'Error fetching documents'
      });
    }

    res.json({
      success: true,
      data: documents,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });

  } catch (error) {
    console.error('Get documents error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
};

// @desc    Get single document by ID
const getDocumentById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const { data: document, error } = await supabase
      .from('documents')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error || !document) {
      return res.status(404).json({
        success: false,
        error: 'Document not found'
      });
    }

    // Log view in audit trail
    await supabase
      .from('audit_logs')
      .insert([
        {
          user_id: userId,
          action: 'DOCUMENT_VIEWED',
          details: { document_id: id, title: document.title },
          ip_address: req.ip,
          user_agent: req.get('user-agent')
        }
      ]);

    res.json({
      success: true,
      data: document
    });

  } catch (error) {
    console.error('Get document error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
};

// @desc    Update document metadata
const updateDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { title, description, status } = req.body;

    const { data: existingDoc, error: checkError } = await supabase
      .from('documents')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (checkError || !existingDoc) {
      return res.status(404).json({
        success: false,
        error: 'Document not found'
      });
    }

    const { data: document, error: updateError } = await supabase
      .from('documents')
      .update({
        title: title || existingDoc.title,
        description: description !== undefined ? description : existingDoc.description,
        status: status || existingDoc.status,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('user_id', userId)
      .select('*')
      .single();

    if (updateError) {
      console.error('Error updating document:', updateError);
      return res.status(500).json({
        success: false,
        error: 'Error updating document'
      });
    }

    // Log update in audit trail
    await supabase
      .from('audit_logs')
      .insert([
        {
          user_id: userId,
          action: 'DOCUMENT_UPDATED',
          details: { 
            document_id: id, 
            changes: req.body 
          },
          ip_address: req.ip,
          user_agent: req.get('user-agent')
        }
      ]);

    res.json({
      success: true,
      message: 'Document updated successfully',
      data: document
    });

  } catch (error) {
    console.error('Update document error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
};

// @desc    Delete document
const deleteDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const { data: document, error: checkError } = await supabase
      .from('documents')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (checkError || !document) {
      return res.status(404).json({
        success: false,
        error: 'Document not found'
      });
    }

    // Delete from storage using admin client
    if (document.file_path) {
      const { error: storageError } = await supabaseAdmin.storage
        .from('documents')
        .remove([document.file_path]);

      if (storageError) {
        console.error('Error deleting from storage:', storageError);
      }
    }

    // Delete from database
    const { error: deleteError } = await supabase
      .from('documents')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (deleteError) {
      console.error('Error deleting document:', deleteError);
      return res.status(500).json({
        success: false,
        error: 'Error deleting document'
      });
    }

    // Log deletion in audit trail
    await supabase
      .from('audit_logs')
      .insert([
        {
          user_id: userId,
          action: 'DOCUMENT_DELETED',
          details: { 
            document_id: id, 
            title: document.title,
            file_name: document.file_name 
          },
          ip_address: req.ip,
          user_agent: req.get('user-agent')
        }
      ]);

    res.json({
      success: true,
      message: 'Document deleted successfully'
    });

  } catch (error) {
    console.error('Delete document error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
};

// @desc    Download document
const downloadDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const { data: document, error } = await supabase
      .from('documents')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error || !document) {
      return res.status(404).json({
        success: false,
        error: 'Document not found'
      });
    }

    // Download from storage using admin client
    const { data, error: downloadError } = await supabaseAdmin.storage
      .from('documents')
      .download(document.file_path);

    if (downloadError) {
      console.error('Error downloading file:', downloadError);
      return res.status(500).json({
        success: false,
        error: 'Error downloading file'
      });
    }

    // Log download in audit trail
    await supabase
      .from('audit_logs')
      .insert([
        {
          user_id: userId,
          action: 'DOCUMENT_DOWNLOADED',
          details: { document_id: id, title: document.title },
          ip_address: req.ip,
          user_agent: req.get('user-agent')
        }
      ]);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${document.file_name}"`);
    res.send(Buffer.from(await data.arrayBuffer()));

  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
};
// @desc    Get document statistics
// @route   GET /api/documents/stats
// @access  Private
const getDocumentStats = async (req, res) => {
  try {
    const userId = req.user.id;

    // Get all documents for user
    const { data: documents, error } = await supabase
      .from('documents')
      .select('status, file_size')
      .eq('user_id', userId);

    if (error) {
      console.error('Error fetching stats:', error);
      return res.status(500).json({
        success: false,
        error: 'Error fetching document statistics'
      });
    }

    // Calculate stats
    const stats = {
      total: documents.length,
      pending: documents.filter(d => d.status === 'pending').length,
      signed: documents.filter(d => d.status === 'signed').length,
      rejected: documents.filter(d => d.status === 'rejected').length,
      totalSize: documents.reduce((acc, doc) => acc + (doc.file_size || 0), 0)
    };

    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
};

// @desc    Search documents
// @route   GET /api/documents/search
// @access  Private
const searchDocuments = async (req, res) => {
  try {
    const userId = req.user.id;
    const { q } = req.query;

    if (!q) {
      return res.status(400).json({
        success: false,
        error: 'Search query is required'
      });
    }

    const { data: documents, error } = await supabase
      .from('documents')
      .select('*')
      .eq('user_id', userId)
      .or(`title.ilike.%${q}%,file_name.ilike.%${q}%,description.ilike.%${q}%`)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Search error:', error);
      return res.status(500).json({
        success: false,
        error: 'Error searching documents'
      });
    }

    res.json({
      success: true,
      data: documents,
      count: documents.length
    });

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
};

// @desc    Get recent documents
// @route   GET /api/documents/recent
// @access  Private
const getRecentDocuments = async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 5 } = req.query;

    const { data: documents, error } = await supabase
      .from('documents')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error fetching recent documents:', error);
      return res.status(500).json({
        success: false,
        error: 'Error fetching recent documents'
      });
    }

    res.json({
      success: true,
      data: documents
    });

  } catch (error) {
    console.error('Recent documents error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
};

// Export new methods
module.exports = {
  uploadDocument,
  getDocuments,
  getDocumentById,
  updateDocument,
  deleteDocument,
  downloadDocument,
  getDocumentStats,
  searchDocuments,
  getRecentDocuments
};