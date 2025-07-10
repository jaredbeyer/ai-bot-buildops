const { buildOpsApiCall } = require('./index');
const RingCentral = require('@ringcentral/sdk').SDK;
const redis = require('redis');

const rc = new RingCentral({
  clientId: 'fWYB21mOOAoajJwatxuoCb',
  clientSecret: 'c8R13cJanGYbi8sfrvsIPq6RmcEmkcYP1bQ2ThauxXwR',
  server: 'https://platform.ringcentral.com'
});

const redisClient = redis.createClient({ url: process.env.REDIS_URL });

(async () => {
  await redisClient.connect();
  await rc.login({ username: process.env.RINGCENTRAL_USERNAME, password: process.env.RINGCENTRAL_PASSWORD });
})();

async function scheduleAppointment(sessionId, customerId, propertyId, issue, appointmentTime) {
  const jobData = {
    customerId,
    description: issue,
    appointmentTime,
    addresses: [{ id: propertyId, addressType: 'propertyAddress' }]
  };
  const job = await buildOpsApiCall('/jobs', 'POST', jobData);
  await sendSMS(job.customerId, `Appointment scheduled for ${new Date(appointmentTime).toLocaleString()}. Job ID: ${job.id}`);
}

async function initiateCallback(customerId, phone) {
  const sessionId = `callback_${Date.now()}`;
  await redisClient.set(`session:${sessionId}`, JSON.stringify({
    step: 'askTime',
    customerId,
    phone
  }));
  await rc.post('/restapi/v1.0/account/~/telephony/sessions', {
    from: { phoneNumber: process.env.RINGCENTRAL_PHONE_NUMBER },
    to: { phoneNumber: phone }
  });
  console.log(`Initiated callback to ${phone} for session ${sessionId}`);
}

async function sendSMS(to, message) {
  await rc.post('/restapi/v1.0/account/~/extension/~/sms', {
    from: { phoneNumber: process.env.RINGCENTRAL_PHONE_NUMBER },
    to: [{ phoneNumber: to }],
    text: message
  });
}

module.exports = { scheduleAppointment, initiateCallback, sendSMS };
