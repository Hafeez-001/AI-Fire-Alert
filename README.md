# AI Fire Alert & Detection System 🔥

An AI-powered real-time fire detection and surveillance system built for early hazard warning and emergency response. This system processes live camera feeds using deep learning (YOLOv8) to identify flames instantly and trigger automated alerts.

---

## 📌 Project Overview

Traditional hardware smoke and heat detectors can be slow to respond in large spaces, open halls, or well-ventilated environments. This project provides a computer vision-based solution that continuously monitors video streams (webcams, CCTV, or RTSP streams) and detects fires in real time.

When a fire is detected:
- An audible siren alert is triggered on the dashboard.
- Real-time visual bounding boxes show the exact fire location.
- Incident snapshots are captured and saved to the database.
- Instant notifications can be sent to responders via Telegram and Email.

---

## ✨ Features

- **Real-Time Fire Detection**: Uses a trained YOLOv8 model for high-accuracy and low-latency fire identification.
- **Multi-Camera Grid**: Add and monitor multiple cameras (Webcams, IP cameras, RTSP streams) simultaneously.
- **Interactive Web Dashboard**: Modern UI to view live feeds, inspect camera status, and analyze stats.
- **Custom Detection Zones**: Draw custom polygon regions on each camera view to prevent false alarms outside the monitored area.
- **Alerts & Notifications**: Automatic siren alarm with options for instant Email and Telegram notification alerts with captured images.
- **Image Analysis Tool**: Upload static images directly from the dashboard to test model detection accuracy.
- **Incident History & Logs**: Complete log of past fire events with timestamps and high-definition snapshots.

---

## 🛠️ Tech Stack

| Component | Technologies Used |
| :--- | :--- |
| **Deep Learning & CV** | YOLOv8 (Ultralytics), OpenCV, PyTorch |
| **Backend API** | Python, FastAPI, Uvicorn, WebSockets, SQLite |
| **Frontend UI** | Next.js, React, TypeScript, Tailwind CSS, Recharts |

---

## 📁 Project Structure

```
AI-Fire-Alert/
├── backend/
│   ├── main.py              # FastAPI server & WebSocket handlers
│   ├── camera_manager.py    # Camera stream processing & video capture
│   ├── detection.py         # YOLO model inference
│   ├── detection_policy.py  # Alert triggers, persistence & cooldown logic
│   ├── database.py          # SQLite database operations
│   ├── notification.py      # Email & Telegram alert services
│   ├── best.pt              # Trained YOLOv8 fire detection model weights
│   └── requirements.txt     # Python backend dependencies
├── frontend/
│   ├── src/                 # React components & dashboard UI
│   ├── package.json         # Node.js dependencies
│   └── public/              # Static assets & icons
├── docs/                    # Screenshots & documentation
├── start.bat                # One-click startup script (Windows)
└── README.md                # Project documentation
```

---

## 🚀 Getting Started

### Prerequisites

Ensure you have the following installed on your machine:
- **Python** (version 3.10 or higher)
- **Node.js** (version 18 or higher) & **npm**
- A connected **Webcam** or **IP Camera stream** (optional for live testing)

---

### Method 1: Quick Start (Windows)

Simply double-click the `start.bat` file in the project root directory, or run in PowerShell/CMD:

```cmd
start.bat
```

This script will automatically detect Python, create the virtual environment, install requirements, install frontend dependencies, and launch both the backend and frontend servers.

---

### Method 2: Manual Setup

#### 1. Setup Backend
```bash
# Navigate to backend directory
cd backend

# Create and activate virtual environment
python -m venv venv

# On Windows:
venv\Scripts\activate
# On macOS/Linux:
# source venv/bin/activate

# Install required dependencies
pip install -r requirements.txt

# Run the backend server
python -m uvicorn main:app --reload --port 8000
```
> The backend server will run at `http://localhost:8000`.

#### 2. Setup Frontend
Open a new terminal window:
```bash
# Navigate to frontend directory
cd frontend

# Install dependencies
npm install

# Start the frontend dev server
npm run dev
```
> The web dashboard will be available at `http://localhost:3000`.

---

## 🖥️ How to Use

1. Open `http://localhost:3000` in your web browser.
2. Click **Add Camera** to add your camera:
   - For a laptop/USB webcam, enter index `0`.
   - For an RTSP/IP camera, enter the stream URL (e.g. `rtsp://...`).
3. Click on the camera card to draw a custom detection zone (optional).
4. Go to **Settings** to customize confidence thresholds, toggle the alarm siren, or configure Telegram/Email alert credentials.
5. In case of fire, the system will highlight the flame, sound the alarm, and log the incident in the **History** tab.

---

## 🔮 Future Scope

- Integration of smoke detection models alongside fire detection.
- Mobile application notifications (Push notifications).
- Integration with IoT microcontrollers (ESP32 / Raspberry Pi) for physical alarms or water sprinklers.
- Drone and aerial camera integration for forest fire surveillance.

---

## 👨‍💻 Author

**Mohammad Hafeez**  
- GitHub: [@Hafeez-001](https://github.com/Hafeez-001)

---

## 📄 License

This project is open-source and available under the [MIT License](LICENSE).
