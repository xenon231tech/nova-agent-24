const responses = [
    'That is interesting!',
    'I can help you with that.',
    'Let me think about it...',
    'Great question!',
    'I understand what you mean.'
];

let messages = [];

function sendMessage() {
    const input = document.getElementById('user-input').value;
    if (input) {
        messages.push({user: true, text: input});
        const response = responses[Math.floor(Math.random() * responses.length)];
        messages.push({user: false, text: response});
        document.getElementById('user-input').value = '';
        updateChat();
    }
}

function updateChat() {
    document.getElementById('chat').innerHTML = messages.map(msg => `
        <div style="text-align: ${msg.user ? 'right' : 'left'}; margin: 10px 0;">
            <div style="background: ${msg.user ? '#007bff' : '#e9ecef'}; padding: 10px; border-radius: 10px; display: inline-block; max-width: 70%;">
                ${msg.text}
            </div>
        </div>
    `).join('');
    document.getElementById('chat').scrollTop = document.getElementById('chat').scrollHeight;
}