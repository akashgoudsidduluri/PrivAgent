set -e
./node_modules/.bin/esbuild scratch/starttask_probe.ts --bundle --platform=node --format=cjs --outfile=scratch/.starttask_probe.cjs --log-level=error
node scratch/.starttask_probe.cjs
