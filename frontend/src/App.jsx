import React, { useState, useRef, useEffect } from 'react';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import axios from 'axios';
import './App.css';

const API_URL = 'http://localhost:8000';

// Constants
const AUDIO_CHUNK_INTERVAL = 250; // ms
const SILENCE_THRESHOLD = 2000; // 2 seconds of silence before auto-processing
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_FILE_TYPES = ['.txt'];
const SUPPORTED_MIME_TYPES = [
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/mp4'
];

function App() {
  // State management
  const [documentUploaded, setDocumentUploaded] = useState(false);
  const [documentTitle, setDocumentTitle] = useState('');
  const [chunksCount, setChunksCount] = useState(0);
  const [uploading, setUploading] = useState(false);
  
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false); // New: indicates actively listening for user speech
  const [transcript, setTranscript] = useState('');
  const [response, setResponse] = useState('');
  const [error, setError] = useState('');
  
  const [chatHistory, setChatHistory] = useState([]);
  
  // Refs
  const mediaRecorderRef = useRef(null);
  const deepgramSocketRef = useRef(null);
  const deepgramApiKeyRef = useRef(null);
  const transcriptBufferRef = useRef('');
  const audioStreamRef = useRef(null);
  const isProcessingRef = useRef(false); // Prevent duplicate processing
  const silenceTimerRef = useRef(null); // Timer for detecting silence
  const isContinuousModeRef = useRef(true); // Always in continuous mode
  const isSpeakingRef = useRef(false);

  // Fetch Deepgram API key on mount
  useEffect(() => {
    fetchApiKeys();
    checkDocumentStatus();
    
    // Cleanup function
    return () => {
      // Clear silence timer
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      
      // Clean up any active connections
      if (deepgramSocketRef.current) {
        try {
          deepgramSocketRef.current.finish();
        } catch (err) {
          console.error('Error closing Deepgram connection:', err);
        }
        deepgramSocketRef.current = null;
      }
      
      // Stop any active media streams
      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach(track => track.stop());
        audioStreamRef.current = null;
      }
      
      // Stop media recorder
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  const fetchApiKeys = async () => {
    try {
      const res = await axios.get(`${API_URL}/api-keys`);
      const apiKey = res.data?.deepgram_api_key;
      
      if (!apiKey) {
        throw new Error('Deepgram API key not found in response');
      }
      
      deepgramApiKeyRef.current = apiKey;
      console.log('✅ Deepgram API key loaded');
    } catch (err) {
      const errorMsg = 'Failed to fetch API keys: ' + (err.response?.data?.detail || err.message);
      setError(errorMsg);
      console.error('❌', errorMsg);
    }
  };

  const checkDocumentStatus = async () => {
    try {
      const res = await axios.get(`${API_URL}/health`);
      if (res.data.document_loaded) {
        setDocumentUploaded(true);
        setDocumentTitle(res.data.document_title);
        setChunksCount(res.data.chunks_count);
      }
    } catch (err) {
      console.error('Health check failed:', err);
    }
  };

  // Document upload handler
  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    const fileExtension = '.' + file.name.split('.').pop().toLowerCase();
    if (!ALLOWED_FILE_TYPES.includes(fileExtension)) {
      setError(`Invalid file type. Please upload a ${ALLOWED_FILE_TYPES.join(', ')} file.`);
      return;
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      setError(`File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)}MB.`);
      return;
    }

    console.log('📄 Uploading file:', file.name, `(${(file.size / 1024).toFixed(2)} KB)`);
    setUploading(true);
    setError('');

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await axios.post(`${API_URL}/upload-document`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });

      console.log('✅ Upload response:', res.data);
      setDocumentUploaded(true);
      setDocumentTitle(res.data.document_title);
      setChunksCount(res.data.chunks_count);
      setUploading(false);
    } catch (err) {
      console.error('❌ Upload error:', err);
      setError('Failed to upload document: ' + (err.response?.data?.detail || err.message));
      setUploading(false);
    }
  };

  // Start recording and streaming to Deepgram
  const startRecording = async () => {
    try {
      // Validate API key before starting
      if (!deepgramApiKeyRef.current) {
        setError('Deepgram API key not loaded. Please refresh the page.');
        return;
      }

      setError('');
      setTranscript('');
      setResponse('');
      setIsRecording(true);

      // Connect with microphone
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            sampleRate: 16000
          }
        });
        audioStreamRef.current = stream;
      } catch (micErr) {
        let errorMessage = 'Failed to access microphone: ';
        if (micErr.name === 'NotAllowedError') {
          errorMessage += 'Permission denied. Please allow microphone access in your browser settings.';
        } else if (micErr.name === 'NotFoundError') {
          errorMessage += 'No microphone found. Please connect a microphone.';
        } else if (micErr.name === 'NotReadableError') {
          errorMessage += 'Microphone is already in use by another application.';
        } else {
          errorMessage += micErr.message;
        }
        throw new Error(errorMessage);
      }
      
      // mimeType selection
      let mimeType = SUPPORTED_MIME_TYPES.find(type => MediaRecorder.isTypeSupported(type));
      
      if (!mimeType) {
        console.warn('⚠️  No supported MIME type found, using default');
        mimeType = 'audio/webm'; // Fallback
      }
      
      console.log('🎙️  Selected MIME type:', mimeType);
      
      // Create Deepgram WebSocket connection with matching encoding
      const deepgram = createClient(deepgramApiKeyRef.current);
      
      console.log('🔌 Creating Deepgram live connection with encoding:', mimeType.includes('webm') ? 'webm-opus' : 'linear16');
      
      const connection = deepgram.listen.live({
        model: 'nova-2',
        language: 'en',
        smart_format: true,
        interim_results: true,
        punctuate: true,
        // Don't specify encoding - let Deepgram auto-detect from WebM
      });

      deepgramSocketRef.current = connection;

      // Set up MediaRecorder first (but don't start yet)
      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;

      let chunksSent = 0;
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && deepgramSocketRef.current) {
          try {
            const readyState = deepgramSocketRef.current.getReadyState();
            console.log('🎵 Audio chunk available - Size:', event.data.size, 'bytes, WebSocket state:', readyState);
            
            if (readyState === 1) { // OPEN
              deepgramSocketRef.current.send(event.data);
              chunksSent++;
              if (chunksSent % 10 === 0) {
                console.log(`📤 Sent ${chunksSent} audio chunks to Deepgram`);
              }
            } else {
              console.warn('⚠️  WebSocket not open, state:', readyState);
            }
          } catch (sendErr) {
            console.error('❌ Error sending audio chunk:', sendErr);
          }
        } else {
          console.warn('⚠️  No data or no connection - Data size:', event.data?.size, 'Connection:', !!deepgramSocketRef.current);
        }
      };

      mediaRecorder.onerror = (event) => {
        console.error('❌ MediaRecorder error:', event);
        setError('Recording error occurred');
      };

      connection.on(LiveTranscriptionEvents.Open, () => {
        console.log('✅ Deepgram connection opened - Continuous mode active');
        transcriptBufferRef.current = ''; // Reset buffer
        setIsListening(true); // Set listening state

        // START RECORDING ONLY AFTER WEBSOCKET IS OPEN
        mediaRecorder.start(AUDIO_CHUNK_INTERVAL);
        console.log('🎙️  Recording started in continuous mode');
      });

      connection.on(LiveTranscriptionEvents.Transcript, (data) => {
        // Don't process if currently speaking or processing
        if (isSpeakingRef.current || isProcessingRef.current) {
          console.log('🔇 Ignoring transcript - system is speaking or processing');
          return;
        }

        const transcriptText = data?.channel?.alternatives?.[0]?.transcript;
        const isFinal = data?.is_final || false;
        
        console.log('📝 Transcript:', transcriptText, 'is_final:', isFinal, 'continuous mode');
        
        if (transcriptText && transcriptText.trim()) {
          // Clear any existing silence timer
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }

          if (isFinal) {
            // Add to buffer
            transcriptBufferRef.current += ' ' + transcriptText;
            const currentTranscript = transcriptBufferRef.current.trim();
            setTranscript(currentTranscript);
            console.log('✅ Updated transcript buffer:', currentTranscript);

            // Start silence timer - if user stops speaking for SILENCE_THRESHOLD, process the question
            silenceTimerRef.current = setTimeout(() => {
              console.log('🤫 Silence detected - auto-processing transcript');
              if (transcriptBufferRef.current.trim() && !isProcessingRef.current) {
                setIsListening(false); // Stop listening while processing
                processTranscript();
              }
            }, SILENCE_THRESHOLD);
          } else {
            // Show interim results
            const interimTranscript = transcriptBufferRef.current + ' ' + transcriptText;
            setTranscript(interimTranscript.trim());
            console.log('ℹ️  Interim result:', interimTranscript.trim());
          }
        }
      });

      connection.on(LiveTranscriptionEvents.Error, (err) => {
        console.error('❌ Deepgram error:', err);
        setError('Transcription error occurred: ' + (err?.message || 'Unknown error'));
      });

      connection.on(LiveTranscriptionEvents.Close, () => {
        console.log('🔒 Deepgram connection closed - Conversation ended');
        setIsListening(false);
        setIsRecording(false);
        
        // Clear any pending silence timer
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        }
      });

      connection.on(LiveTranscriptionEvents.Metadata, (data) => {
        console.log('📊 Metadata:', data);
      });

    } catch (err) {
      console.error('❌ Recording error:', err);
      setError(err.message || 'Failed to start recording');
      setIsRecording(false);
      
      // Cleanup on error
      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach(track => track.stop());
        audioStreamRef.current = null;
      }
    }
  };

  // Stop conversation - called when user clicks "Stop Conversation"
  const stopRecording = () => {
    console.log('⏹️  Stopping conversation mode...');
    
    setIsRecording(false);
    setIsListening(false);
    
    // Clear any pending silence timer
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    
    // Stop MediaRecorder
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
        mediaRecorderRef.current = null;
      } catch (err) {
        console.error('Error stopping MediaRecorder:', err);
      }
    }
    
    // Stop audio stream
    if (audioStreamRef.current) {
      try {
        audioStreamRef.current.getTracks().forEach(track => track.stop());
        audioStreamRef.current = null;
      } catch (err) {
        console.error('Error stopping audio stream:', err);
      }
    }

    // Close Deepgram connection immediately
    if (deepgramSocketRef.current) {
      try {
        deepgramSocketRef.current.finish();
        console.log('🔒 Deepgram connection finished');
      } catch (err) {
        console.error('Error closing Deepgram connection:', err);
      }
      deepgramSocketRef.current = null;
    }
    
    console.log('✅ Conversation ended');
  };

  // Process transcript with RAG and get voice response
  const processTranscript = async () => {
    // Prevent duplicate processing
    if (isProcessingRef.current) {
      console.log('⚠️  Already processing, skipping duplicate call');
      return;
    }
    
    const currentTranscript = transcriptBufferRef.current.trim();
    
    console.log('📤 Processing transcript:', currentTranscript);
    
    if (!currentTranscript) {
      setError('No transcript to process. Please speak and try again.');
      return;
    }

    isProcessingRef.current = true;
    setIsProcessing(true);
    setError('');

    try {
      // Query the RAG system
      console.log('🔍 Querying RAG system...');
      const queryRes = await axios.post(`${API_URL}/query`, {
        query: currentTranscript,
        top_k: 5
      });

      const answer = queryRes.data.answer;
      console.log('💬 Received answer:', answer);

      // Convert response to speech using Deepgram TTS.
      // We delay showing the textual answer until audio playback actually begins
      // so the text and voice are synchronized.
      console.log('🗣️  Converting to speech... (will display text when audio starts)');
      await speakResponse(answer, currentTranscript);

      // In continuous mode: Clear transcript buffer and prepare for next question
      console.log('🔄 Clearing transcript buffer - ready for next question');
      transcriptBufferRef.current = '';
      setTranscript(''); // Clear displayed transcript
      isProcessingRef.current = false;
      setIsProcessing(false);

      // Resume listening after speaking (if still in recording mode)
      if (isRecording && deepgramSocketRef.current) {
        setIsListening(true);
        console.log('👂 Listening for next question...');
      }

    } catch (err) {
      console.error('❌ Processing error:', err);
      setError('Failed to process query: ' + (err.response?.data?.detail || err.message));
      isProcessingRef.current = false;
      setIsProcessing(false);
      
      // Resume listening even after error
      if (isRecording && deepgramSocketRef.current) {
        setIsListening(true);
      }
    }
  };

  // Text-to-Speech using backend proxy to Deepgram Aura
  // speakResponse now accepts the text and the original question and will
  // display the textual answer at the moment audio playback begins so both
  // text and voice appear in sync.
  const speakResponse = async (text, question) => {
    try {
  setIsSpeaking(true);
  isSpeakingRef.current = true;
      console.log('🗣️  Generating speech via backend...');

      // Use backend TTS endpoint to avoid CORS issues
      const response = await axios.post(`${API_URL}/tts`, {
        text: text,
        model: 'aura-asteria-en'
      }, {
        responseType: 'blob', // Important: receive as blob
        timeout: 60000 // allow up to 60s for TTS generation/transfer
      });

      // Create audio blob and play
      const audioBlob = new Blob([response.data], { type: 'audio/wav' });
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);

      // When playback actually starts, show the textual response and add to history
      const onPlayHandler = () => {
        console.log('▶️  Audio playback started - syncing text display');
        setResponse(text);
        setChatHistory(prev => [...prev, {
          question: question,
          answer: text,
          timestamp: new Date().toLocaleTimeString()
        }]);
        // remove this handler after it fires
        audio.removeEventListener('play', onPlayHandler);
      };

      audio.addEventListener('play', onPlayHandler);

      audio.onended = () => {
        setIsSpeaking(false);
        isSpeakingRef.current = false;
        URL.revokeObjectURL(audioUrl); // Clean up blob URL
        console.log('✅ Audio playback completed');
      };

      audio.onerror = (err) => {
        setIsSpeaking(false);
        isSpeakingRef.current = false;
        console.error('❌ Audio playback error:', err);
        setError('Failed to play audio response');
        // Fallback: ensure the text is shown even if audio playback fails
        setResponse(text);
        setChatHistory(prev => [...prev, {
          question: question,
          answer: text,
          timestamp: new Date().toLocaleTimeString()
        }]);
      };

      // Start playback - await ensures we know when playback begins (or rejects)
      await audio.play();
      console.log('▶️  Playing audio response');

    } catch (err) {
      console.error('❌ TTS error:', err);
      setError('Failed to generate speech: ' + (err?.response?.data?.detail || err?.message || 'Unknown error'));
  setIsSpeaking(false);
  isSpeakingRef.current = false;
      // Fallback: display the text answer immediately if TTS failed
      setResponse(text);
      setChatHistory(prev => [...prev, {
        question: question,
        answer: text,
        timestamp: new Date().toLocaleTimeString()
      }]);
    }
  };

  // Reset document
  const resetDocument = () => {
    setDocumentUploaded(false);
    setDocumentTitle('');
    setChunksCount(0);
    setChatHistory([]);
    setTranscript('');
    setResponse('');
  };

  return (
    <div className="app">
      <div className="container">
        {/* Header */}
        <header className="header">
          <h1>🎤 Voice RAG Chat</h1>
          <p>Real-time voice conversations with your documents</p>
        </header>

        {/* Document Upload Section */}
        {!documentUploaded ? (
          <div className="upload-section">
            <div className="upload-card">
              <h2>📄 Upload Document</h2>
              <p>Upload a text document to start chatting</p>
              
              <label className="file-input-label">
                <input
                  type="file"
                  accept=".txt"
                  onChange={handleFileUpload}
                  disabled={uploading}
                  className="file-input"
                />
                <span className="file-input-button">
                  {uploading ? '⏳ Uploading...' : '📁 Choose File'}
                </span>
              </label>

              {error && <div className="error">{error}</div>}
            </div>

            <div className="info-section">
              <h3>How it works:</h3>
              <div className="info-grid">
                <div className="info-item">
                  <span className="info-icon">1️⃣</span>
                  <p>Upload your document</p>
                </div>
                <div className="info-item">
                  <span className="info-icon">2️⃣</span>
                  <p>Start conversation & speak naturally</p>
                </div>
                <div className="info-item">
                  <span className="info-icon">3️⃣</span>
                  <p>AI auto-detects pauses & responds</p>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Document Info Bar */}
            <div className="document-info">
              <div className="doc-details">
                <span className="doc-icon">📄</span>
                <div>
                  <strong>{documentTitle}</strong>
                  <small>{chunksCount} chunks</small>
                </div>
              </div>
              <button onClick={resetDocument} className="btn-secondary">
                🔄 New Document
              </button>
            </div>

            {/* Voice Controls */}
            <div className="voice-controls">
              <div className="recording-status">
                {isRecording && isListening && !isProcessing && !isSpeaking && (
                  <div className="recording-indicator">
                    <span className="pulse"></span>
                    👂 Listening... (speak naturally, I'll detect when you finish)
                  </div>
                )}
                {isProcessing && (
                  <div className="processing-indicator">
                    ⏳ Processing your question...
                  </div>
                )}
                {isSpeaking && (
                  <div className="speaking-indicator">
                    🔊 Speaking response...
                  </div>
                )}
                {isRecording && !isListening && !isProcessing && !isSpeaking && (
                  <div className="recording-indicator">
                    <span className="pulse"></span>
                    🎙️  Preparing...
                  </div>
                )}
              </div>

              <div className="control-buttons">
                {!isRecording ? (
                  <button
                    onClick={startRecording}
                    className="btn-primary btn-large"
                    disabled={isProcessing || isSpeaking}
                  >
                    🎤 Start Conversation
                  </button>
                ) : (
                  <>
                    <button
                      onClick={stopRecording}
                      className="btn-danger btn-large"
                    >
                      ⏹️ Stop Conversation
                    </button>
                  </>
                )}
              </div>

              {/* Show current transcript while in conversation */}
              {isRecording && transcript && (
                <div className="transcript-box">
                  <h4>💬 Current Transcript:</h4>
                  <p>{transcript}</p>
                </div>
              )}

              {/* Show hint when not recording */}
              {!transcript && !isRecording && !isProcessing && (
                <div className="hint-text">
                  <small>💡 Click "Start Conversation" and speak naturally. The system will automatically detect pauses and respond.</small>
                </div>
              )}

              {/* Show last response */}
              {response && !isSpeaking && (
                <div className="response-box">
                  <h4>AI Response:</h4>
                  <p>{response}</p>
                </div>
              )}

              {error && <div className="error">{error}</div>}
            </div>

            {/* Chat History */}
            {chatHistory.length > 0 && (
              <div className="chat-history">
                <h3>💬 Conversation History</h3>
                {chatHistory.map((chat, idx) => (
                  <div key={idx} className="chat-item">
                    <div className="chat-time">{chat.timestamp}</div>
                    <div className="chat-question">
                      <strong>You:</strong> {chat.question}
                    </div>
                    <div className="chat-answer">
                      <strong>AI:</strong> {chat.answer}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Footer */}
        <footer className="footer">
          <p>🎤 Powered by Deepgram Nova 2 | 🤖 OpenAI GPT-3.5 | 🔍 FAISS</p>
        </footer>
      </div>
    </div>
  );
}

export default App;
