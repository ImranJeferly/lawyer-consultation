// Entry point for the backend application
import dotenv from 'dotenv';
import { httpServer } from './app';

// Load environment variables
dotenv.config();

const PORT = process.env.PORT || 3000;

httpServer.listen(Number(PORT), '0.0.0.0', () => {
  console.log(' Server running on port ' + PORT);
  console.log(' Health check: http://localhost:' + PORT + '/health');
  console.log(' Server accessible from: http://0.0.0.0:' + PORT + '/health');
});
