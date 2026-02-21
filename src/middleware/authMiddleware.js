const { verifyToken } = require('../utils/tokenUtils');
const supabase = require('../utils/supabase');
const supabaseAdmin = require('../utils/supabaseAdmin');

const protect = async (req, res, next) => {
  try {
    let token;

    // Check for token in Authorization header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    console.log('🔐 Auth middleware called');
    console.log('🔐 Authorization header:', req.headers.authorization ? 'Bearer ' + req.headers.authorization.substring(0, 30) + '...' : 'none');
    console.log('🔐 Token extracted:', token ? 'YES' : 'NO');

    if (!token) {
      console.log('❌ No token provided');
      return res.status(401).json({
        success: false,
        error: 'Not authorized to access this route'
      });
    }

    // Check if this is a Supabase token (starts with eyJhbGciOiJFUzI1Ni - ES256 algorithm)
    const isSupabaseToken = token.startsWith('eyJhbGciOiJFUzI1Ni');
    
    if (isSupabaseToken) {
      console.log('🔑 Detected Supabase token, verifying with Supabase...');
      
      // Verify token with Supabase
      const { data: { user: supabaseUser }, error: verifyError } = await supabaseAdmin.auth.getUser(token);
      
      if (verifyError || !supabaseUser) {
        console.log('❌ Supabase token verification failed:', verifyError);
        return res.status(401).json({
          success: false,
          error: 'Invalid or expired token'
        });
      }
      
      console.log('✅ Supabase token verified for user:', supabaseUser.email);
      
      // Get user from our database using supabase_id
      const { data: user, error: userError } = await supabaseAdmin
        .from('users')
        .select('id, name, email, created_at, avatar_url, auth_provider')
        .eq('supabase_id', supabaseUser.id)
        .single();
      
      if (userError || !user) {
        console.log('❌ User not found in database for supabase_id:', supabaseUser.id);
        
        // If user doesn't exist in our DB but has Supabase auth, create them
        const { data: newUser, error: createError } = await supabaseAdmin
          .from('users')
          .insert([
            {
              supabase_id: supabaseUser.id,
              email: supabaseUser.email,
              name: supabaseUser.user_metadata?.full_name || supabaseUser.email.split('@')[0],
              avatar_url: supabaseUser.user_metadata?.avatar_url,
              auth_provider: 'google',
              email_verified: true,
            }
          ])
          .select()
          .single();
          
        if (createError) {
          console.error('❌ Failed to create user:', createError);
          return res.status(401).json({
            success: false,
            error: 'User not found'
          });
        }
        
        console.log('✅ Created new user from Supabase token:', newUser.email);
        req.user = newUser;
        return next();
      }
      
      console.log('✅ User found in database:', user.email);
      req.user = user;
      return next();
    } else {
      // This is our JWT token
      console.log('🔐 Verifying JWT token...');
      const decoded = verifyToken(token);
      
      if (!decoded) {
        console.log('❌ JWT token verification failed');
        return res.status(401).json({
          success: false,
          error: 'Invalid or expired token'
        });
      }

      console.log('✅ JWT token decoded:', { id: decoded.id, email: decoded.email });

      // Get user from database
      const { data: user, error } = await supabase
        .from('users')
        .select('id, name, email, created_at, avatar_url, auth_provider')
        .eq('id', decoded.id)
        .single();

      if (!user) {
        console.log('❌ User not found in database');
        return res.status(401).json({
          success: false,
          error: 'User not found'
        });
      }

      console.log('✅ User authenticated:', user.email);
      req.user = user;
      return next();
    }
  } catch (error) {
    console.error('❌ Auth middleware error:', error);
    res.status(401).json({
      success: false,
      error: 'Not authorized to access this route'
    });
  }
};

module.exports = { protect };