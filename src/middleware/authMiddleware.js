const { verifyToken } = require('../utils/tokenUtils');
const supabase = require('../utils/supabase');

const protect = async (req, res, next) => {
  try {
    let token;

    // Check for token in Authorization header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    // ADD DEBUGGING
    console.log('🔐 Auth middleware called');
    console.log('🔐 Authorization header:', req.headers.authorization?.substring(0, 30) + '...');
    console.log('🔐 Token extracted:', token ? 'YES' : 'NO');

    if (!token) {
      console.log('❌ No token provided');
      return res.status(401).json({
        success: false,
        error: 'Not authorized to access this route'
      });
    }

    // Verify token
    console.log('🔐 Verifying token...');
    const decoded = verifyToken(token);
    
    if (!decoded) {
      console.log('❌ Token verification failed');
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired token'
      });
    }

    console.log('✅ Token decoded:', { id: decoded.id, email: decoded.email });

    // Get user from database
    const { data: user, error } = await supabase
      .from('users')
      .select('id, name, email, created_at')
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

    // Attach user to request object
    req.user = user;
    next();

  } catch (error) {
    console.error('❌ Auth middleware error:', error);
    res.status(401).json({
      success: false,
      error: 'Not authorized to access this route'
    });
  }
};

module.exports = { protect };