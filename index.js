require('dotenv').config();
const express = require('express');
const axios = require('axios');
const redis = require('redis');
const { sendCustomerForm, handleFormSubmission, createNewCustomerForm } = require('./newCustomer');
const { scheduleAppointment, initiateCallback } = require('./appointment');

const app = express();
app.use(express.json());

const REDIS_URL = process.env.REDIS_URL;
const redisClient = redis.createClient({ url: REDIS_URL });

const BUILDOPS_CONFIG = {
  baseURL: 'https://api.buildops.com/v1',
  clientId: process.env.BUILDOPS_CLIENT_ID,
  clientSecret: process.env.BUILDOPS_CLIENT_SECRET,
  tenantId: process.env.BUILDOPS_TENANT_ID
};

const RINGCENTRAL_CONFIG = {
  clientId: 'fWYB21mOOAoajJwatxuoCb',
  clientSecret: 'c8R13cJanGYbi8sfrvsIPq6RmcEmkcYP1bQ2ThauxXwR',
  server: 'https://platform.ringcentral.com'
};

(async () => {
  await redisClient.connect();
})();

async function getBuildOpsToken() {
  const response = await axios.post(`${BUILDOPS_CONFIG.baseURL}/auth/token`, {
    clientId: BUILDOPS_CONFIG.clientId,
    clientSecret: BUILDOPS_CONFIG.clientSecret
  });
  return response.data.access_token;
}

async function buildOpsApiCall(endpoint, method = 'GET', data = null) {
  const token = await getBuildOpsToken();
  const config = {
    method,
    url: `${BUILDOPS_CONFIG.baseURL}${endpoint}`,
    headers: { Authorization: `Bearer ${token}`, tenantId: BUILDOPS_CONFIG.tenantId },
    data
  };
  try {
    const response = await axios(config);
    return response.data;
  } catch (error) {
    console.error(`BuildOps API Error: ${error.response?.data?.errorMessage || error.message}`);
    throw error;
  }
}

// RingCentral webhook for call initiation
app.post('/webhook', async (req, res) => {
  const { from, callId } = req.body;
  const sessionId = callId || `call_${Date.now()}`;
  await redisClient.set(`session:${sessionId}`, JSON.stringify({ step: 'initial', callerNumber: from }));
  res.json({ action: 'connect', redirect: process.env.DIALOGFLOW_PHONE_GATEWAY });
  await processSession(sessionId);
});

// Dialogflow webhook for IVR and chatbot
app.post('/dialogflow-webhook', async (req, res) => {
  const sessionId = req.body.session.split('/').pop();
  const intent = req.body.queryResult.intent.displayName;
  const parameters = req.body.queryResult.parameters;
  let sessionState = JSON.parse(await redisClient.get(`session:${sessionId}`)) || { step: 'initial' };

  if (intent === 'StartConversation') {
    sessionState = { ...sessionState, step: 'askPhone' };
    await redisClient.set(`session:${sessionId}`, JSON.stringify(sessionState));
    res.json({ fulfillmentText: 'Welcome! Please provide your phone number.' });
  } else if (intent === 'ProvidePhone') {
    const phone = parameters.phone || sessionState.callerNumber;
    const customers = await buildOpsApiCall('/customers?page=1&limit=100');
    const customer = customers.items.find(c => c.phonePrimary === phone || c.phoneAlternate === phone);
    sessionState = { ...sessionState, step: customer ? 'askProperty' : 'askAddress', customerId: customer?.id, phone };
    await redisClient.set(`session:${sessionId}`, JSON.stringify(sessionState));
    if (customer) {
      const properties = customer.addressList.items.map(a => a.addressLine1).join(', ');
      res.json({ fulfillmentText: `Found your account. Which property are you calling about? ${properties}` });
    } else {
      res.json({ fulfillmentText: 'No account found. Please provide the property address.' });
    }
  } else if (intent === 'ProvideProperty') {
    sessionState = { ...sessionState, step: 'askIssue', propertyId: parameters.propertyId };
    await redisClient.set(`session:${sessionId}`, JSON.stringify(sessionState));
    res.json({ fulfillmentText: 'What’s the issue with the property?' });
  } else if (intent === 'ProvideIssue') {
    sessionState = { ...sessionState, step: 'askTime', issue: parameters.issue };
    await redisClient.set(`session:${sessionId}`, JSON.stringify(sessionState));
    res.json({ fulfillmentText: 'When would you like your appointment? E.g., tomorrow at 10 AM.' });
  } else if (intent === 'ProvideTime') {
    const appointmentTime = parameters.dateTime;
    sessionState = { ...sessionState, step: 'confirm', appointmentTime };
    await redisClient.set(`session:${sessionId}`, JSON.stringify(sessionState));
    await scheduleAppointment(sessionId, sessionState.customerId, sessionState.propertyId, sessionState.issue, appointmentTime);
    res.json({ fulfillmentText: `Appointment scheduled for ${new Date(appointmentTime).toLocaleString()}. You’ll receive an SMS confirmation.` });
  } else if (intent === 'ProvideAddress') {
    const address = parameters.address;
    const properties = await buildOpsApiCall(`/customers/${sessionState.customerId || '0'}/addresses`);
    const property = properties.items.find(p => p.addressLine1 === address);
    if (property) {
      sessionState = { ...sessionState, step: 'askIssue', propertyId: property.id };
      await redisClient.set(`session:${sessionId}`, JSON.stringify(sessionState));
      res.json({ fulfillmentText: 'What’s the issue with the property?' });
    } else {
      sessionState = { ...sessionState, step: 'newCustomer', address };
      await redisClient.set(`session:${sessionId}`, JSON.stringify(sessionState));
      res.json({ fulfillmentText: 'Are you a new customer? Please provide your email and phone number.' });
    }
  } else if (intent === 'ProvideNewCustomerInfo') {
    sessionState = { ...sessionState, step: 'confirmNewCustomer', email: parameters.email, phone: parameters.phone };
    await redisClient.set(`session:${sessionId}`, JSON.stringify(sessionState));
    const formLink = await createNewCustomerForm(parameters.email, parameters.phone, sessionId);
    await sendCustomerForm(parameters.email, formLink);
    res.json({ fulfillmentText: 'Thank you. We’ve sent a form to your email. Please complete it, and we’ll call you to schedule.' });
  }
});

// Botpress webhook for Siloam chatbot
app.post('/chatbot-webhook', async (req, res) => {
  req.body = { session: `projects/your-agent/sessions/${req.body.sessionId}`, queryResult: { intent: { displayName: req.body.intent }, parameters: req.body.parameters } };
  await app._router.handle({ method: 'POST', url: '/dialogflow-webhook', body: req.body }, res);
});

async function processSession(sessionId) {
  let sessionState = JSON.parse(await redisClient.get(`session:${sessionId}`));
  if (sessionState.step === 'initial') {
    await sendDialogflowEvent(sessionId, 'StartConversation');
  }
}

async function sendDialogflowEvent(sessionId, intent, parameters = {}) {
  console.log(`Triggering Dialogflow intent: ${intent} for session ${sessionId}`);
}

app.post('/form-webhook', async (req, res) => {
  await handleFormSubmission(req.body);
  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => console.log('Server running'));
