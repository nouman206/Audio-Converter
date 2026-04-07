const express = require("express");
const AWS = require("aws-sdk");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");
const os = require("os");
const axios = require("axios");
const FormData = require("form-data");
const app = express();
const SONIOX_BASE_URL = "https://api.soniox.com/v1";

// ── Request queue: max 2 merge jobs at a time ────────────────────────
const MAX_CONCURRENT_JOBS = 2;
let activeJobs = 0;
const jobQueue = [];

function enqueue() {
  return new Promise((resolve) => {
    if (activeJobs < MAX_CONCURRENT_JOBS) {
      activeJobs++;
      resolve();
    } else {
      jobQueue.push(resolve);
    }
  });
}

function dequeue() {
  activeJobs--;
  if (jobQueue.length > 0) {
    activeJobs++;
    jobQueue.shift()();
  }
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({limit: '50mb', extended: false }));

app.post("/", async (req, res) => {
    try {
        let { audio_data, audio_chunck, last_chunck, name } = req.body;

        let pro = [];
        if (audio_chunck) {
            pro.push(convertToWav(audio_chunck, name + "_ch"));
        }
        if (last_chunck) {
            // Process lastChunk to extract the last 2 seconds
            const trimmedLastChunk = await extractLastSeconds(last_chunck, name + "_last", 2);
            if (trimmedLastChunk) {
                // Append the extracted part to audio_chunck
                const combinedAudio = await concatenateAudios(trimmedLastChunk, audio_chunck, name + "_final");
                pro.push(convertToWav(combinedAudio, name + "_final"));
            }
        }

        if (audio_data) {
            pro.push(convertToWav(audio_data, name + "_da"));
        }

        

        Promise.all(pro).then((values) => {
            let result = {};

            if (values.length > 0 && values[0]) {
                result.audio_chunck = values[0]['base64'];
                result.audio_chunck_duration = values[0]['duration'];
            }

            if (values.length > 0 && values[1]) {
                result.audio_data = values[1]['base64'];
                result.audio_data_duration = values[1]['duration'];
            }

            return res.status(200).json(result);
        });
    } catch (error) {
        console.error('Error processing audio:', error);
        return res.status(500).json({ message: 'Failed to process audio', error: error.message });
    }
});

function extractLastSeconds(audio, name, seconds) {
    return new Promise((resolve, reject) => {
        const inputFilePath = path.resolve(__dirname, `${name}input.webm`);
        const outputFilePath = path.resolve(__dirname, `${name}trimmed.webm`);

        fs.writeFileSync(inputFilePath, Buffer.from(audio, 'base64'));

        getAudioDuration(inputFilePath).then((duration) => {
            const startTime = Math.max(0, duration - seconds);

            ffmpeg(inputFilePath)
                .setStartTime(startTime)
                .toFormat('webm')
                .on('end', () => {
                    const trimmedBuffer = fs.readFileSync(outputFilePath);
                    resolve(trimmedBuffer.toString('base64'));

                    fs.promises.unlink(inputFilePath);
                    fs.promises.unlink(outputFilePath);
                })
                .on('error', reject)
                .save(outputFilePath);
        }).catch(reject);
    });
}

function concatenateAudios(base64Audio1, base64Audio2, name) {
    return new Promise((resolve, reject) => {
        const inputFile1 = path.resolve(__dirname, `${name}_1.webm`);
        const inputFile2 = path.resolve(__dirname, `${name}_2.webm`);
        const outputFilePath = path.resolve(__dirname, `${name}_merged.webm`);

        fs.writeFileSync(inputFile1, Buffer.from(base64Audio1, 'base64'));
        fs.writeFileSync(inputFile2, Buffer.from(base64Audio2, 'base64'));

        ffmpeg()
            .input(inputFile1)
            .input(inputFile2)
            .on('end', () => {
                const mergedBuffer = fs.readFileSync(outputFilePath);
                resolve(mergedBuffer.toString('base64'));

                fs.promises.unlink(inputFile1);
                fs.promises.unlink(inputFile2);
                fs.promises.unlink(outputFilePath);
            })
            .on('error', reject)
            .mergeToFile(outputFilePath, __dirname);
    });
}

function convertToWav(audio, name) {
    return new Promise(async (resolve, reject) => {
        const inputFilePath = path.resolve(__dirname, `${name}input.webm`);
        const outputFilePath = path.resolve(__dirname, `${name}output.webm`);

        // Save the input file to the file system
        fs.writeFileSync(inputFilePath, Buffer.from(audio, 'base64'));

        try {
            await convert(inputFilePath, outputFilePath);
            console.log("File Converted Successfully");

            // Get duration
            const duration = await getAudioDuration(outputFilePath);

            // Read the converted file
            const outputFileBuffer = fs.readFileSync(outputFilePath);
            const outputBase64 = outputFileBuffer.toString('base64');

            // Clean up files
            await fs.promises.unlink(inputFilePath);
            await fs.promises.unlink(outputFilePath);

            resolve({ base64: outputBase64, duration });
        } catch (error) {
            reject(error);
        }
    });
}

function convert(inputFilePath, outputFilePath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputFilePath)
            .toFormat('webm')  // Change to 'wav' if you need WAV format
            .on('start', commandLine => {
                console.log('FFmpeg command:', commandLine);
            })
            .on('end', resolve)
            .on('error', (err, stdout, stderr) => {
                console.error('FFmpeg error:', err);
                console.error('FFmpeg stdout:', stdout || 'No stdout');
                console.error('FFmpeg stderr:', stderr || 'No stderr');
                reject(err);
            })
            .save(outputFilePath);
    });
}

function getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                reject(err);
            } else {
                resolve(metadata.format.duration); // Duration in seconds
            }
        });
    });
}

// ── Background merge + transcribe function ───────────────────────────
async function processMergeAndTranscribe({ s3Bucket, audioPrefix, audioFormat, sonioxApiKey, s3Region, userToken, visit_id, mergedKey, summary_template }) {
  const ext = audioFormat.startsWith(".") ? audioFormat : `.${audioFormat}`;
  const s3 = new AWS.S3({ region: s3Region });

  await enqueue();
  console.log(`[queue] slot acquired for visit_id: ${visit_id}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-merge-"));

  try {
    // ── 1. List all matching objects in S3 ────────────────────────────
    console.log(`[s3] listing objects with prefix "${audioPrefix}" ...`);

    let allKeys = [];
    let continuationToken = null;

    do {
      const params = {
        Bucket: s3Bucket,
        Prefix: audioPrefix,
        ...(continuationToken && { ContinuationToken: continuationToken }),
      };

      const listing = await s3.listObjectsV2(params).promise();
      const keys = (listing.Contents || [])
        .map((obj) => obj.Key)
        .filter((key) => key.endsWith(ext));

      allKeys.push(...keys);
      continuationToken = listing.IsTruncated
        ? listing.NextContinuationToken
        : null;
    } while (continuationToken);

    if (allKeys.length === 0) {
      console.error(`[process] no chunks found for visit_id: ${visit_id}`);
      return;
    }

    // ── 2. Sort by numeric index ──────────────────────────────────────
    allKeys.sort((a, b) => {
      const idxA =
        parseInt(a.replace(audioPrefix, "").replace(ext, ""), 10) || 0;
      const idxB =
        parseInt(b.replace(audioPrefix, "").replace(ext, ""), 10) || 0;
      return idxA - idxB;
    });

    console.log(`[s3] found ${allKeys.length} chunks`);

    // ── 3. Download all chunks ────────────────────────────────────────
    console.log("[download] downloading chunks ...");

    const CONCURRENCY = 20;
    const localPaths = new Array(allKeys.length);

    for (let i = 0; i < allKeys.length; i += CONCURRENCY) {
      const batch = allKeys.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map((key, batchIdx) => {
          return new Promise((resolve, reject) => {
            const localFile = path.join(tmpDir, path.basename(key));
            const writeStream = fs.createWriteStream(localFile);
            const readStream = s3
              .getObject({ Bucket: s3Bucket, Key: key })
              .createReadStream();
            readStream.pipe(writeStream);
            writeStream.on("finish", () => {
              localPaths[i + batchIdx] = localFile;
              resolve();
            });
            readStream.on("error", reject);
            writeStream.on("error", reject);
          });
        })
      );
      if ((i + CONCURRENCY) % 100 === 0 || i + CONCURRENCY >= allKeys.length) {
        console.log(`[download] ${Math.min(i + CONCURRENCY, allKeys.length)}/${allKeys.length} chunks downloaded`);
      }
    }

    console.log(`[download] ${localPaths.length} chunks saved`);

    // ── 4. Merge with ffmpeg ──────────────────────────────────────────
    const concatListPath = path.join(tmpDir, "concat.txt");
    const concatContent = localPaths
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n");
    fs.writeFileSync(concatListPath, concatContent);

    const mergedPath = path.join(tmpDir, `merged${ext}`);

    // Step 1: concat chunks → WAV (strips all WebM timestamps)
    const wavPath = path.join(tmpDir, "intermediate.wav");
    console.log("[ffmpeg] step 1: concat chunks to WAV ...");
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatListPath)
        .inputOptions(["-f", "concat", "-safe", "0"])
        .outputOptions("-c:a", "pcm_s16le", "-ar", "48000", "-ac", "1")
        .output(wavPath)
        .on("start", (cmd) => console.log(`[ffmpeg] ${cmd}`))
        .on("error", (err) =>
          reject(new Error(`ffmpeg concat→wav error: ${err.message}`))
        )
        .on("end", () => {
          console.log("[ffmpeg] WAV intermediate ready");
          resolve();
        })
        .run();
    });

    // Step 2: WAV → final WebM (clean timestamps guaranteed)
    console.log("[ffmpeg] step 2: WAV to WebM ...");
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(wavPath)
        .outputOptions("-c:a", "libopus", "-b:a", "128k")
        .output(mergedPath)
        .on("start", (cmd) => console.log(`[ffmpeg] ${cmd}`))
        .on("error", (err) =>
          reject(new Error(`ffmpeg wav→webm error: ${err.message}`))
        )
        .on("end", () => {
          console.log("[ffmpeg] merge complete");
          resolve();
        })
        .run();
    });
    fs.unlinkSync(wavPath);

    // ── 5. Upload merged file back to S3 ────────────────────────────────
    console.log(`[s3] uploading full file to s3://${s3Bucket}/${mergedKey} ...`);
    await s3
      .upload({
        Bucket: s3Bucket,
        Key: mergedKey,
        Body: fs.createReadStream(mergedPath),
      })
      .promise();
    console.log("[s3] full file uploaded");

    // ── 6. Upload to Soniox ───────────────────────────────────────────
    console.log("[soniox] uploading full file ...");

    const form = new FormData();
    form.append("file", fs.createReadStream(mergedPath), {
      filename: mergedKey,
    });

    const response = await axios.post(`${SONIOX_BASE_URL}/files`, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${sonioxApiKey}`,
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    const fileId = response.data.id;
    console.log(`[soniox] upload complete — file ID: ${fileId}`);

    // ── 7. Notify callback endpoint ─────────────────────────────────────
    console.log(`[callback] notifying completion for visit_id: ${visit_id}`);
    try {
      await axios.post(process.env.CALLBACK_URL, {
        visit_id,
        is_call_soniox: true,
        soniox_id: fileId,
        summary_template: summary_template || null
      }, {
        headers: {
          Authorization: userToken,
        },
      });
      console.log("[callback] notification sent");
    } catch (cbErr) {
      const respData = cbErr.response ? JSON.stringify(cbErr.response.data) : "no response body";
      console.error(`[callback] failed (${cbErr.response?.status}): ${respData}`);
    }

  } catch (err) {
    console.error(`[process] error for visit_id ${visit_id}:`, err.message);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log("[cleanup] temp directory removed");
    dequeue();
    console.log(`[queue] slot released (${activeJobs}/${MAX_CONCURRENT_JOBS} active, ${jobQueue.length} queued)`);
  }
}

app.post("/api/merge-and-transcribe", async (req, res) => {
  const {
    s3Bucket,
    audioFormat,
    sonioxApiKey,
    s3Region = "us-east-1",
    userToken,
    visit_id,
    summary_template
  } = req.body;

  // ── Validate ────────────────────────────────────────────────────────
  const missing = [];
  if (!s3Bucket) missing.push("s3Bucket");
  if (!audioFormat) missing.push("audioFormat");
  if (!sonioxApiKey) missing.push("sonioxApiKey");
  if (!visit_id) missing.push("visit_id");
  if (!userToken) missing.push("userToken");

  if (missing.length > 0) {
    return res.status(400).json({
      success: false,
      error: `Missing required fields: ${missing.join(", ")}`,
    });
  }

  const ext = audioFormat.startsWith(".") ? audioFormat : `.${audioFormat}`;
  const s3 = new AWS.S3({ region: s3Region });
  const audioPrefix = `${visit_id}_audio_`;
  const mergedKey = `${visit_id}_audio_full${ext}`;

  // ── Check if full merged audio already exists in S3 ─────────────────
  try {
    await s3.headObject({ Bucket: s3Bucket, Key: mergedKey }).promise();
    console.log(`[s3] full file already exists: ${mergedKey}`);
    return res.json({ success: true, exists: true, mergedKey });
  } catch (err) {
    if (err.code !== "NotFound") {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ── Kick off background processing and return immediately ───────────
  processMergeAndTranscribe({
    s3Bucket, audioPrefix, audioFormat, sonioxApiKey, s3Region, userToken, visit_id, mergedKey, summary_template
  });

  return res.json({
    success: true,
    processing: true,
    message: "Processing started. You will be notified when combining is complete.",
  });
});

app.listen(3004, () => console.log("App is Running on Port 3004"));
