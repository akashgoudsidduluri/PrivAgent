import { spawn } from 'child_process';

const extPath = 'C:\\privagent_dist';
console.log('Extension path:', extPath);

const p = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--remote-debugging-port=9222',
  '--user-data-dir=C:\\Users\\AKASH\\AppData\\Local\\Temp\\privagent_cdp_profile',
  `--load-extension=${extPath}`,
  '--enable-unsafe-extension-debugging',
  '--no-first-run',
  '--no-default-browser-check',
  'http://localhost:5173',
  'http://localhost:4173'
], { stdio: 'inherit' });

p.on('error', console.error);
p.on('exit', (code) => console.log('Exited with', code));
