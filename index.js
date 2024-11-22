const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const express = require('express');
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({limit: '50mb', extended: false }));

app.post("/", async (req, res) => {
    try {
        let { audio_data, audio_chunck, name } = req.body;

        let pro = [];

        if(audio_data){
            pro.push(convertToWav(audio_data, name+"_da"))
        }

        if(audio_chunck){
            pro.push(convertToWav(audio_chunck, name+"_ch"))
        }

        Promise.all(pro).then((values) => {
            let result = {};

            if(values.length > 0 && values[0]){
                result.audio_data =  values[0]['base64']
                result.audio_data_duration =  values[0]['duration']
            }

            if(values.length > 0 && values[1]){
                result.audio_chunck =  values[1]['base64']
                result.audio_chunck_duration =  values[1]['duration']
            }

            return res.status(200).json(result);
        });
    } catch (error) {
        console.error('Error converting audio:', error);
        return res.status(500).json({ message: 'Failed to convert audio', error: error.message });
    }
});


function convertToWav(audio, name) {
    return new Promise(async (resolve, reject) => {
        const inputFilePath = path.resolve(__dirname, `${name}input.mp3`);
        const outputFilePath = path.resolve(__dirname, `${name}output.mp3`);

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

app.listen(3004, () => console.log("App is Running on Port 3004"));