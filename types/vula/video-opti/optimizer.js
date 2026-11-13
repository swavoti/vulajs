const { FFmpeg } = require('@ffmpeg/ffmpeg');
const { fetchFile } = require('@ffmpeg/util');
const fs = require('fs');
const path = require('path');

let ffmpegInstance = null;

async function getFFmpeg() {
  if (!ffmpegInstance) {
    ffmpegInstance = new FFmpeg();
    await ffmpegInstance.load();
  }
  return ffmpegInstance;
}

async function optimizeVideo(inputPath, outputDir, fileName) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const m3u8Path = path.join(outputDir, `${fileName}.m3u8`);
  
  if (fs.existsSync(m3u8Path)) {
    return m3u8Path; // Already chunked
  }

  console.log(`[vula-video-opti] Transcoding ${inputPath} to HLS...`);
  const ffmpeg = await getFFmpeg();
  const inputName = path.basename(inputPath);
  
  await ffmpeg.writeFile(inputName, await fetchFile(inputPath));

  // Run FFmpeg to generate HLS chunks
  await ffmpeg.exec([
    '-i', inputName,
    '-codec:', 'copy', // Fast copy (assuming input is already h264)
    '-start_number', '0',
    '-hls_time', '10', // 10 second chunks
    '-hls_list_size', '0',
    '-f', 'hls',
    `${fileName}.m3u8`
  ]);

  // Read playlist
  const m3u8Data = await ffmpeg.readFile(`${fileName}.m3u8`);
  fs.writeFileSync(m3u8Path, Buffer.from(m3u8Data));

  // Read generated chunks sequentially
  let chunkIndex = 0;
  while (true) {
    const tsName = `${fileName}${chunkIndex}.ts`;
    try {
      const tsData = await ffmpeg.readFile(tsName);
      fs.writeFileSync(path.join(outputDir, tsName), Buffer.from(tsData));
      chunkIndex++;
    } catch (e) {
      // Reached the end of the chunks
      break;
    }
  }

  console.log(`[vula-video-opti] Successfully chunked ${inputName} into ${chunkIndex} segments.`);
  return m3u8Path;
}

module.exports = { optimizeVideo };
