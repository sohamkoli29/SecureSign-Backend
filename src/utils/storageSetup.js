const supabase = require('./supabase');

const setupStorage = async () => {
  try {
    console.log('🔧 Setting up Supabase Storage...');

    // Check if bucket exists
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    
    if (listError) {
      console.error('Error listing buckets:', listError);
      return false;
    }

    const documentsBucket = buckets.find(b => b.name === 'documents');

    if (!documentsBucket) {
      console.log('Creating documents bucket...');
      
      // Create the bucket
      const { data, error } = await supabase.storage.createBucket('documents', {
        public: true, // Make bucket public for easy access
        allowedMimeTypes: ['application/pdf'],
        fileSizeLimit: 10485760 // 10MB in bytes
      });

      if (error) {
        console.error('Error creating bucket:', error);
        return false;
      }

      console.log('✅ Documents bucket created successfully');
    } else {
      console.log('✅ Documents bucket already exists');
      
      // Update bucket settings if needed
      const { error: updateError } = await supabase.storage.updateBucket('documents', {
        public: true,
        allowedMimeTypes: ['application/pdf'],
        fileSizeLimit: 10485760
      });

      if (updateError) {
        console.error('Error updating bucket:', updateError);
      } else {
        console.log('✅ Bucket settings updated');
      }
    }

    return true;
  } catch (error) {
    console.error('Storage setup error:', error);
    return false;
  }
};

module.exports = { setupStorage };