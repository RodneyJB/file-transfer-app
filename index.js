const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const app = express();
app.use(express.json());

require('dotenv').config();
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;

app.post('/file-handler', async (req, res) => {
    console.log('✅ Request received from Monday');
    console.log('🧠 Incoming body:', JSON.stringify(req.body, null, 2));

    const input = req.body.payload?.inputFields || {};
    const { itemId, boardId, columnId } = input;

    if (!itemId || !boardId || !columnId) {
        console.log('❌ Missing input fields');
        return res.status(400).send('Missing required input fields.');
    }

    try {
        const query = `
            query {
                items(ids: ${itemId}) {
                    updates {
                        assets {
                            public_url
                            name
                        }
                    }
                }
            }
        `;

        console.log('📦 Sending GraphQL query...');
        const response = await axios.post(
            'https://api.monday.com/v2',
            { query },
            { headers: { Authorization: MONDAY_API_KEY } }
        );

        const updates = response.data?.data?.items?.[0]?.updates || [];
        const assets = updates.flatMap(u => u.assets || []);
        console.log('📎 Found update files:', assets.map(a => a.name));

        const pdfs = assets.filter(file => file.name.toLowerCase().endsWith('.pdf'));
        if (pdfs.length === 0) {
            console.log('⚠️ No PDF files found.');
            return res.send({ message: 'No PDF files found.' });
        }

        for (const pdf of pdfs) {
            console.log(`📤 Uploading: ${pdf.name}`);

            const fileResponse = await axios.get(pdf.public_url, { responseType: 'stream' });

            const form = new FormData();
            form.append('query', `
                mutation ($file: File!) {
                    add_file_to_column (file: $file, item_id: ${itemId}, column_id: "${columnId}") {
                        id
                    }
                }
            `);
            form.append('variables[file]', fileResponse.data, {
                filename: pdf.name,
                contentType: 'application/pdf'
            });

            await axios.post('https://api.monday.com/v2/file', form, {
                headers: {
                    ...form.getHeaders(),
                    Authorization: MONDAY_API_KEY
                }
            });

            console.log(`✅ Uploaded: ${pdf.name}`);
        }

        res.send({ message: 'All PDFs uploaded to column.' });

    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
        res.status(500).send('Error processing PDF files');
    }
});

app.listen(3000, () => console.log('Server running on port 3000'));
