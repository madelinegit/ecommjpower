// ================================================================
// FIREBASE SETUP — fill this in before the reviews page will work
// ================================================================
// 1. Go to https://console.firebase.google.com
// 2. Click "Add project" and follow the steps
// 3. Inside the project, click the </> (Web) icon to add a web app
// 4. Copy the firebaseConfig object values below
// 5. In the Firebase console left sidebar:
//      - Build > Firestore Database  → Create database (start in test mode)
//      - Build > Storage             → Get started (test mode)
//      - Build > Authentication      → Get started > Email/Password → Enable
//      - Authentication > Users      → Add user (James's email + password)
// ================================================================

const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID"
};
