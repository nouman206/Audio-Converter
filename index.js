const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const express = require('express');
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({limit: '50mb', extended: false }));

app.post("/", async (req, res) => {
    try {
        let { audio, name } = req.body;
        const inputFilePath = path.resolve(__dirname, `${name}input.mp3`);
        const outputFilePath = path.resolve(__dirname, `${name}output.mp3`);

        // Save the input file to the file system
        fs.writeFileSync(inputFilePath, Buffer.from(audio, 'base64'));

        await convertToWav(inputFilePath, outputFilePath);
        console.log("File Converted Successfully");

        // Read the converted file
        const outputFileBuffer = fs.readFileSync(outputFilePath);
        const outputBase64 = outputFileBuffer.toString('base64');
        
        // Clean up files
        await fs.promises.unlink(inputFilePath);
        await fs.promises.unlink(outputFilePath);

        return res.status(200).json({ audio: outputBase64 });
    } catch (error) {
        console.error('Error converting audio:', error);
        return res.status(500).json({ message: 'Failed to convert audio', error: error.message });
    }
});

function convertToWav(inputFilePath, outputFilePath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputFilePath)
            .toFormat('mp3')  // Change to 'wav' if you need WAV format
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

app.listen(3004, () => console.log("App is Running on Port 3004"));
