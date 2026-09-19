import dotenv from 'dotenv';

dotenv.config();

export const config = {
  supabase: {
    url: process.env.SUPABASE_URL || '',
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || '',
    secretKey: process.env.SUPABASE_SECRET_KEY || '',
    jwksUrl: process.env.SUPABASE_JWKS_URL || '',
  },
  database: {
    url: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || process.env.LOCAL_DATABASE_URL || '',
  },
};
