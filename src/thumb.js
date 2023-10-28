const sharp = require('sharp');
const fs = require('fs');

const dir = 'web/img/products/';

fs.readdir(dir, (err, files) => {
 files.forEach((file) => {
  if (file.endsWith('.jpg') || file.endsWith('.png')) {
   console.log(dir + file);
   //makeThumb(dir + file, dir + file.substring(0, file.lastIndexOf('.')) + '_sm.jpg', 640, 80);
  }
 });
});

makeThumb(dir + '1.jpg', '1_sm.jpg', 640, 80);

function makeThumb(inFile, outFile, width, quality) {
 sharp(inFile)
  .resize(width)
  .jpeg({ quality: quality })
  .toFile(outFile, (err, info) => {
   if (err) console.error(err);
  });
}
