# Voice RAG Chat Application

A real-time voice chat application that allows you to have conversations with your documents using voice input and output.

## Architecture

```
User speaks → Microphone → WebSocket → Deepgram STT → Text
                                                         ↓
User hears ← Audio playback ← Deepgram TTS ← Response ← RAG System (FAISS + OpenAI)
```

## Features

- 📄 **Document Upload**: Upload text documents for processing
- 🎤 **Real-time Voice Input**: Speak naturally to ask questions
- 🗣️ **Voice Response**: Get answers in voice format
- 🔍 **FAISS Vector Search**: Fast similarity search for relevant context
- 🤖 **OpenAI GPT-3.5**: Intelligent question answering
- ⚡ **Deepgram Nova 2**: High-quality speech-to-text transcription
- 🎧 **Deepgram Aura**: Natural text-to-speech synthesis

## Tech Stack

### Backend
- FastAPI
- Python 3.13
- FAISS (Vector Database)
- OpenAI API
- tiktoken

### Frontend
- React 18
- Vite
- Deepgram SDK
- Axios

## Setup Instructions

### 1. Environment Variables

Create a `.env` file in the root directory:

```env
OPENAI_API_KEY=your_openai_api_key
DEEPGRAM_API_KEY=your_deepgram_api_key
```

### 2. Backend Setup

```bash
# Navigate to backend directory
cd backend

# Install dependencies
pip install -r requirements.txt

# Run the FastAPI server
python main.py
```

The backend will run on `http://localhost:8000`

### 3. Frontend Setup

```bash
# Navigate to frontend directory
cd frontend

# Install dependencies
npm install

# Run the development server
npm run dev
```

The frontend will run on `http://localhost:3000`

## Usage

1. **Upload Document**: Click "Choose File" and upload a `.txt` file
2. **Start Speaking**: Click the "Start Speaking" button and ask your question
3. **Stop Recording**: Click "Stop Recording" when you're done speaking
4. **Send Question**: Review your transcribed question and click "Send Question"
5. **Listen to Response**: The AI will answer and speak the response back to you

## API Endpoints

### Backend API

- `GET /` - Health check
- `GET /health` - Document status
- `POST /upload-document` - Upload and process document
- `POST /query` - Query the RAG system
- `GET /api-keys` - Get Deepgram API key for frontend

## Project Structure

```
Voice_rag/
├── backend/
│   ├── main.py              # FastAPI application
│   └── requirements.txt     # Python dependencies
├── frontend/
│   ├── src/
│   │   ├── App.jsx         # Main React component
│   │   ├── App.css         # Styles
│   │   ├── main.jsx        # Entry point
│   │   └── index.css       # Global styles
│   ├── index.html          # HTML template
│   ├── package.json        # Node dependencies
│   └── vite.config.js      # Vite configuration
├── .env                    # Environment variables
└── README.md              # This file
```

## Requirements

- Python 3.13+
- Node.js 18+
- OpenAI API key
- Deepgram API key
- Modern web browser with microphone access

## Troubleshooting

### Microphone not working
- Ensure you've granted microphone permissions in your browser
- Check browser console for errors
- Use HTTPS in production (required for microphone access)

### No audio playback
- Check browser audio settings
- Ensure Deepgram TTS API is working
- Check browser console for errors

### Backend errors
- Verify API keys are set correctly in `.env`
- Check backend logs for specific error messages
- Ensure all dependencies are installed

## License

MIT
