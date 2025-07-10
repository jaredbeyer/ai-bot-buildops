const sgMail = require('@sendgrid/mail');
const redis = require('redis');
const { buildOpsApiCall } = require('./index');
const { initiateCallback } = require('./appointment');

sgMail.setApiKey('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');
const redisClient = redis.createClient({ url: process.env.REDIS_URL });

(async () => {
  await redisClient.connect();
})();

async function createNewCustomerForm(email, phone, sessionId) {
  const formId = `form_${Date.now()}`;
  await redisClient.set(`form:${formId}`, JSON.stringify({ email, phone, sessionId, status: 'pending' }));
  return `https://yourtypeform.com/to/${formId}`; // Replace with actual Typeform URL
}

async function sendCustomerForm(email, formLink) {
  const msg = {
    to: email,
    from: 'yourbusiness@example.com',
    subject: 'Complete Your Customer Profile',
    html: `<p>Please complete the form to become a customer: <a href="${formLink}">${formLink}</a></p>`
  };
  await sgMail.send(msg);
}

async function handleFormSubmission({ formId, data }) {
  const formData = JSON.parse(await redisClient.get(`form:${formId}`));
  if (formData && formData.status === 'pending') {
    const customerData = {
      priceBookId: data.priceBookId || '',
      invoicePresetId: data.invoicePresetId || '',
      invoiceDeliveryPref: data.invoiceDeliveryPref || '',
      name: data.name,
      customerNumber: data.customerNumber || '',
      customerType: data.customerType || '',
      email: formData.email,
      isActive: data.isActive === 'true',
      receiveSMS: data.receiveSMS === 'true',
      status: data.status || 'active',
      sameAddress: data.sameAddress === 'true',
      isTaxable: data.isTaxable === 'true',
      taxExemptIdValue: data.taxExemptIdValue || '',
      paymentTermId: data.paymentTermId || '',
      addresses: [{
        id: data.addressId || '',
        billto: data.billto || '',
        shipTo: data.shipTo || '',
        addressType: data.addressType || 'propertyAddress',
        addressLine1: data.addressLine1,
        addressLine2: data.addressLine2 || '',
        city: data.city,
        state: data.state,
        zipcode: data.zipcode,
        country: data.country || 'USA',
        latitude: data.latitude || '',
        longitude: data.longitude || '',
        status: data.addressStatus || 'active',
        isActive: data.addressIsActive === 'true'
      }],
      accountingAttributes: {
        accountingRefId: data.accountingRefId || '',
        accountingVersion: data.accountingVersion || ''
      }
    };
    const customer = await buildOpsApiCall('/customers', 'POST', customerData);
    await redisClient.set(`form:${formId}`, JSON.stringify({ ...formData, status: 'completed', customerId: customer.id }));
    await initiateCallback(customer.id, formData.phone);
  }
}

module.exports = { createNewCustomerForm, sendCustomerForm, handleFormSubmission };
