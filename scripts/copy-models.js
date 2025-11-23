const fs = require('fs');
const path = require('path');

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
      const readStream = fs.createReadStream(srcPath);
      const writeStream = fs.createWriteStream(destPath);
      
      readStream.pipe(writeStream);
      
      console.log(`Copying: ${srcPath} -> ${destPath}`);
    }
  }
}

// Copy resources directory
const srcDir = path.resolve(__dirname, '../resources');
const destDir = path.resolve(__dirname, '../dist/resources');

console.log('Copying model files...');
copyDirectory(srcDir, destDir);
console.log('Model files copied successfully!');