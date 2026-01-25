const fs = require('fs');
const path = require('path');

const MAX_CHUNK_SIZE = 50 * 1024 * 1024; // 50MB chunks for safety

function copyDirectory(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (let entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      const stats = fs.statSync(srcPath);

      // If file is large, split it
      if (stats.size > MAX_CHUNK_SIZE) {
        console.log(`Splitting large file: ${entry.name} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
        splitFile(srcPath, dest, entry.name);
      } else {
        // Standard copy for small files
        console.log(`Copying: ${entry.name}`);
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

function splitFile(srcPath, destDir, originalName) {
  const fd = fs.openSync(srcPath, 'r');
  const buffer = Buffer.alloc(MAX_CHUNK_SIZE);
  let bytesRead = 0;
  let partIndex = 0;
  const parts = [];

  try {
    while ((bytesRead = fs.readSync(fd, buffer, 0, MAX_CHUNK_SIZE, null)) > 0) {
      const partName = `${originalName}.part${String(partIndex).padStart(3, '0')}`;
      const partPath = path.join(destDir, partName);

      // Write only the bytes read (slice logic if last chunk is smaller)
      const dataToWrite = bytesRead < MAX_CHUNK_SIZE ? buffer.subarray(0, bytesRead) : buffer;
      fs.writeFileSync(partPath, dataToWrite);

      parts.push(partName);
      console.log(`  -> Wrote ${partName} (${(bytesRead / 1024 / 1024).toFixed(2)} MB)`);
      partIndex++;
    }

    // Write Manifest
    const manifestPath = path.join(destDir, `${originalName}.json`);
    const manifest = {
      originalName: originalName,
      totalSize: fs.statSync(srcPath).size,
      parts: parts
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`  -> Manifest written: ${originalName}.json`);

  } finally {
    fs.closeSync(fd);
  }
}

// Copy resources directory
const srcDir = path.resolve(__dirname, '../resources');
const destDir = path.resolve(__dirname, '../dist/resources');

console.log('Copying and processing model files...');
copyDirectory(srcDir, destDir);
console.log('Model processing complete!');