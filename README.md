# Fresh Laundry Project

This is the **Fresh Laundry** project. It includes a **React Native client** and a **backend API**.  

Follow these steps to run the project locally.


1. Clone the repository
git clone https://github.com/divineese/fresh-laundry.git

2. Install dependencies
cd fresh-laundry-project
npm install

3. Run the app
expo start


## Notes
- Make sure your backend API is running.
- Android may require extra setup for networking.

#4. Make sure the client points to the correct backend API.
Open fresh-laundry/screens/SignupScreen.js and update the IP if needed:

const API_URL = 'http://YOUR_COMPUTER_IP:3000/api/register';


Replace YOUR_COMPUTER_IP with your machine’s IP if running the backend on a different computer.

5. Signup & Login

Open the app.

Use the Signup screen to create an account (type your own password).

Login with the same credentials to access the app.