import os
import faiss
import numpy as np
import asyncio
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
from openai import OpenAI
from dotenv import load_dotenv
import tiktoken
from typing import List, Optional
import json
import httpx

# Load environment variables
load_dotenv()

# Initialize FastAPI app
app = FastAPI(title="Voice RAG API")

# Configure CORS for React frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize OpenAI client
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# Global state for document storage
faiss_index = None
chunks = []
doc_title = ""

# ==================== MODELS ====================
class QueryRequest(BaseModel):
    query: str
    top_k: Optional[int] = 5

class QueryResponse(BaseModel):
    answer: str
    retrieved_chunks: List[dict]

# ==================== DOCUMENT PROCESSING ====================
def chunk_text(text: str, doc_title: str, min_tokens: int = 300, max_tokens: int = 500, overlap: int = 50):
    """Chunk text into smaller pieces with token-based splitting."""
    encoding = tiktoken.encoding_for_model("text-embedding-3-small")
    tokens = encoding.encode(text)
    chunks = []
    chunk_id = 0
    i = 0
    
    while i < len(tokens):
        end = min(i + max_tokens, len(tokens))
        chunk_tokens = tokens[i:end]
        
        if len(chunk_tokens) < min_tokens and end < len(tokens):
            i += max_tokens - overlap
            continue
        
        chunk_text = encoding.decode(chunk_tokens)
        chunks.append({
            "text": chunk_text,
            "doc_title": doc_title,
            "chunk_id": chunk_id,
            "token_count": len(chunk_tokens)
        })
        chunk_id += 1
        i += max_tokens - overlap
    
    return chunks

def create_embeddings(chunks: List[dict]):
    """Create embeddings for chunks using OpenAI."""
    texts = [chunk["text"] for chunk in chunks]
    embeddings = []
    batch_size = 100
    
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        response = client.embeddings.create(
            model="text-embedding-3-small",
            input=batch
        )
        embeddings.extend([item.embedding for item in response.data])
    
    return np.array(embeddings, dtype=np.float32)

# ==================== RAG FUNCTIONS ====================
def get_embedding(text: str):
    """Get embedding for a single text query."""
    response = client.embeddings.create(
        model="text-embedding-3-small",
        input=text
    )
    return np.array([response.data[0].embedding], dtype=np.float32)

def retrieve_chunks(query: str, index, chunks: List[dict], top_k: int = 5):
    """Retrieve top-k relevant chunks from FAISS index."""
    query_embedding = get_embedding(query)
    distances, indices = index.search(query_embedding, min(top_k, len(chunks)))
    
    results = []
    for idx in indices[0]:
        if idx < len(chunks):
            results.append(chunks[idx])
    
    return results

def generate_answer(query: str, retrieved_chunks: List[dict]):
    """Generate answer using GPT-3.5-turbo based on retrieved context."""
    context = "\n\n".join([
        f"[{chunk['doc_title']} - Chunk {chunk['chunk_id']}]\n{chunk['text']}" 
        for chunk in retrieved_chunks
    ])
    
    prompt = f"""You are a helpful assistant that answers questions based ONLY on the provided context.

Context:
{context}

Question: {query}

Instructions:
- Answer the question using ONLY information from the context above.
- If the answer cannot be found in the context, say "I cannot find this information in the provided document."
- Be concise, clear, and accurate.
- Keep your answer conversational and natural for voice output.
- Keep responses under 100 words.

Answer:"""
    
    response = client.chat.completions.create(
        model="gpt-3.5-turbo",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3,
        max_tokens=200
    )
    
    return response.choices[0].message.content

# ==================== API ENDPOINTS ====================
@app.get("/")
async def root():
    return {"message": "Voice RAG API is running"}

@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "document_loaded": faiss_index is not None,
        "chunks_count": len(chunks),
        "document_title": doc_title
    }

@app.post("/upload-document")
async def upload_document(file: UploadFile = File(...)):
    """Upload and process a text document."""
    global faiss_index, chunks, doc_title
    
    try:
        print(f"\n📄 Processing document: {file.filename}")
        
        # Read document
        content = await file.read()
        text = content.decode('utf-8')
        doc_title = file.filename.replace('.txt', '')
        
        print(f"📖 Document length: {len(text)} characters")
        
        # Chunk the text
        chunks = chunk_text(text, doc_title)
        print(f"✂️  Created {len(chunks)} chunks")
        
        # Create embeddings
        embeddings = create_embeddings(chunks)
        print(f"🔢 Generated embeddings: {embeddings.shape}")
        
        # Create FAISS index
        dimension = embeddings.shape[1]
        faiss_index = faiss.IndexFlatL2(dimension)
        faiss_index.add(embeddings)
        
        print(f"✅ FAISS index created with {faiss_index.ntotal} vectors")
        
        return {
            "status": "success",
            "document_title": doc_title,
            "chunks_count": len(chunks),
            "message": f"Successfully processed {doc_title}"
        }
    
    except Exception as e:
        print(f"❌ Error processing document: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/query", response_model=QueryResponse)
async def query_document(request: QueryRequest):
    """Query the document using RAG."""
    global faiss_index, chunks
    
    print(f"\n🔍 Received query: {request.query}")
    
    if faiss_index is None or not chunks:
        print("❌ No document loaded")
        raise HTTPException(status_code=400, detail="No document loaded. Please upload a document first.")
    
    try:
        # Retrieve relevant chunks
        retrieved = retrieve_chunks(request.query, faiss_index, chunks, request.top_k)
        print(f"📚 Retrieved {len(retrieved)} chunks")
        
        if not retrieved:
            print("⚠️  No relevant chunks found")
            return QueryResponse(
                answer="I cannot find relevant information in the document.",
                retrieved_chunks=[]
            )
        
        # Generate answer
        answer = generate_answer(request.query, retrieved)
        print(f"💬 Generated answer: {answer[:100]}...")
        
        return QueryResponse(
            answer=answer,
            retrieved_chunks=retrieved
        )
    
    except Exception as e:
        print(f"❌ Query error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api-keys")
async def get_api_keys():
    """Return API keys for frontend (Deepgram only)."""
    deepgram_key = os.getenv("DEEPGRAM_API_KEY")
    
    if not deepgram_key:
        raise HTTPException(status_code=500, detail="Deepgram API key not found")
    
    return {
        "deepgram_api_key": deepgram_key
    }

# ==================== TEXT-TO-SPEECH PROXY ====================
class TTSRequest(BaseModel):
    text: str
    model: Optional[str] = "aura-asteria-en"

@app.post("/tts")
async def text_to_speech(request: TTSRequest):
    """Proxy TTS request to Deepgram to avoid CORS issues."""
    deepgram_key = os.getenv("DEEPGRAM_API_KEY")
    
    if not deepgram_key:
        raise HTTPException(status_code=500, detail="Deepgram API key not found")
    
    max_retries = 2
    retry_count = 0
    
    while retry_count <= max_retries:
        try:
            print(f"🗣️  TTS request for text: {request.text[:50]}... (attempt {retry_count + 1}/{max_retries + 1})")
            
            url = f"https://api.deepgram.com/v1/speak?model={request.model}&encoding=linear16&container=wav"
            
            # Increase timeout to 60 seconds for longer text
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(
                    url,
                    headers={
                        "Authorization": f"Token {deepgram_key}",
                        "Content-Type": "application/json"
                    },
                    json={"text": request.text}
                )
                
                if response.status_code != 200:
                    print(f"❌ Deepgram TTS error: {response.status_code} - {response.text}")
                    raise HTTPException(status_code=response.status_code, detail=f"Deepgram TTS error: {response.text}")
                print(f"📤 Sent TTS request to Deepgram, awaiting response... ", response)
                print(f"✅ TTS audio generated: {len(response.content)} bytes")
                
                return Response(
                    content=response.content,
                    media_type="audio/wav",
                    headers={
                        "Content-Disposition": "inline; filename=speech.wav"
                    }
                )
        
        except httpx.TimeoutException:
            retry_count += 1
            if retry_count > max_retries:
                print(f"❌ TTS request timed out after {max_retries + 1} attempts")
                raise HTTPException(status_code=504, detail="TTS request timed out after multiple attempts")
            print(f"⚠️  TTS timeout, retrying... ({retry_count}/{max_retries})")
            await asyncio.sleep(1)  # Wait 1 second before retry
        
        except httpx.HTTPStatusError as e:
            print(f"❌ HTTP error: {e.response.status_code}")
            raise HTTPException(status_code=e.response.status_code, detail=str(e))
        
        except Exception as e:
            print(f"❌ TTS error: {str(e)}")
            raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
