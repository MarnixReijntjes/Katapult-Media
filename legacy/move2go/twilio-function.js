exports.handler = function(context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();
  
  // Log incoming call details
  console.log('=== Incoming Call ===');
  console.log('Timestamp:', new Date().toISOString());
  console.log('From:', event.From);
  console.log('To:', event.To);
  console.log('CallSid:', event.CallSid);
  console.log('Direction:', event.Direction);
  console.log('Caller Country:', event.FromCountry || 'Unknown');
  console.log('Caller City:', event.FromCity || 'Unknown');
  console.log('Caller State:', event.FromState || 'Unknown');
  console.log('====================');
  
  // Connect to relay server
  const connect = twiml.connect();
  connect.stream({
    url: 'wss://nodejs-relay-server-for-inbound-voice.onrender.com'
  });

  callback(null, twiml);
};
