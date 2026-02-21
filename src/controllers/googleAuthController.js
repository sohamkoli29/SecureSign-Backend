const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

exports.handleGoogleCallback = async (req, res) => {
  try {
    const { supabase_id, email, name, avatar_url, provider } = req.body;

    console.log('📥 Google callback received:', { supabase_id, email, name, provider });

    if (!supabase_id || !email) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: supabase_id and email'
      });
    }

    // First, check if user exists by supabase_id
    let { data: userBySupabaseId, error: fetchBySupabaseError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('supabase_id', supabase_id)
      .maybeSingle();

    if (fetchBySupabaseError) {
      console.error('Error fetching by supabase_id:', fetchBySupabaseError);
    }

    // If not found by supabase_id, check by email
    let { data: userByEmail, error: fetchByEmailError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (fetchByEmailError) {
      console.error('Error fetching by email:', fetchByEmailError);
    }

    let user;

    if (userBySupabaseId) {
      // User exists with this supabase_id - update their info
      console.log('🔄 Updating existing user (found by supabase_id):', userBySupabaseId.id);
      
      const { data: updatedUser, error: updateError } = await supabaseAdmin
        .from('users')
        .update({
          name: name || userBySupabaseId.name,
          avatar_url: avatar_url || userBySupabaseId.avatar_url,
          auth_provider: provider,
          updated_at: new Date().toISOString(),
        })
        .eq('id', userBySupabaseId.id)
        .select()
        .single();

      if (updateError) {
        console.error('Update error:', updateError);
        throw updateError;
      }

      user = updatedUser;
    } else if (userByEmail) {
      // User exists with this email but different supabase_id - link them
      console.log('🔄 Linking existing user (found by email):', userByEmail.id);
      
      const { data: updatedUser, error: updateError } = await supabaseAdmin
        .from('users')
        .update({
          supabase_id: supabase_id,
          name: name || userByEmail.name,
          avatar_url: avatar_url || userByEmail.avatar_url,
          auth_provider: provider,
          email_verified: true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', userByEmail.id)
        .select()
        .single();

      if (updateError) {
        console.error('Update error:', updateError);
        throw updateError;
      }

      user = updatedUser;
    } else {
      // Create new user
      console.log('➕ Creating new user');
      
      const newUser = {
        supabase_id,
        email,
        name: name || email.split('@')[0],
        avatar_url: avatar_url || null,
        auth_provider: provider || 'google',
        email_verified: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      
      console.log('New user data:', newUser);

      const { data: createdUser, error: insertError } = await supabaseAdmin
        .from('users')
        .insert([newUser])
        .select()
        .single();

      if (insertError) {
        console.error('Insert error details:', {
          code: insertError.code,
          message: insertError.message,
          details: insertError.details,
          hint: insertError.hint
        });
        throw insertError;
      }

      user = createdUser;
    }

    console.log('✅ User saved successfully:', { id: user.id, email: user.email });

    // Check if JWT secrets are set
    if (!process.env.JWT_SECRET || !process.env.JWT_REFRESH_SECRET) {
      console.error('❌ JWT secrets not configured');
      return res.status(500).json({
        success: false,
        error: 'Server configuration error'
      });
    }

    // Generate JWT tokens
    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    const refreshToken = jwt.sign(
      { id: user.id },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: '30d' }
    );

    // Log the successful authentication
    await supabaseAdmin
      .from('audit_logs')
      .insert([{
        user_id: user.id,
        action: 'GOOGLE_AUTH_SUCCESS',
        details: { provider, email: user.email },
        ip_address: req.ip,
        user_agent: req.get('user-agent')
      }]);

    res.status(200).json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatar_url: user.avatar_url,
        },
        token,
        refreshToken,
      }
    });

  } catch (error) {
    console.error('❌ Google callback error:', {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
      stack: error.stack
    });
    
    res.status(500).json({
      success: false,
      error: 'Failed to sync user account',
      details: error.message
    });
  }
};