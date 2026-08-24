SELECT 'CREATE DATABASE logistics_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'logistics_test')\gexec

