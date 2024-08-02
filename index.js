const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const express = require('express');
const app = express();

app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({ extended: false }));

app.post("/", async (req,res) => {
    try {
        let {audio, name} = req.body;
        const inputFilePath = './'+name+'input.mp3'; // Adjust the path and extension according to the input file type
        const outputFilePath = './'+name+'output.mp3';
        
        // Save the input file to /tmp directory
        fs.writeFileSync(inputFilePath, Buffer.from(audio, 'base64'));

        await convertToWav(inputFilePath, outputFilePath);
        console.log("File Converted Sucessfully")
        const outputFileBuffer = fs.readFileSync(outputFilePath);
        const outputBase64 = outputFileBuffer.toString('base64');
        await fs.promises.unlink(inputFilePath)
        await fs.promises.unlink(outputFilePath)

        return res.status(200).json({audio: outputBase64});
    } catch (error) {
        console.error('Error converting audio:', error);
        return res.status(500).json({message: 'Failed to convert audio', error: error.message});
    }
});

function convertToWav(inputFilePath, outputFilePath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputFilePath)
            .setFfmpegPath(ffmpegPath)
            .toFormat('mp3')
            .on('end', resolve)
            .on('error', reject)
            .save(outputFilePath);
    });
}


app.listen(3004, ()=> console.log("App is Running on Port 3000"))