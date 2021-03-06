const admin = require('firebase-admin');
const { createId, getIdFromBandcampUrl, getIdFromYoutubeUrl, getIdFromSpotifyUrl } = require('./utils');
const { scrapeGvb, scrapeStereogum, scrapePitchforkTracks, scrapePitchforkAlbums } = require('./crawlers');
const dayjs = require('dayjs');
const scrapeIt = require('scrape-it');

const EMBED_SELECTORS = {
	bleep: '.contents .contents__embed iframe',
	gvb: {
		selector: '.pod-content .lazyload-placeholder',
		attr: "data-pod",
		convert: string => {
			if (!string) {
				return null;
			}
			const html = JSON.parse(string).html;
			return html.match(/src="[^"]*"/gm).map(x => x.replace(/.*src="([^"]*)".*/, '$1'))[0];
		},
	},
	pitchfork: {
		selector: '.contents .contents__embed iframe',
		attr: "src"
	},
	stereogum: {
		selector: '.article-content iframe',
		attr: "data-src"
	},
}

const DATE_SELECTORS = {
	gvb: {
		selector: ".page-header .byline time",
		attr: "datetime",
		convert: string => string ? dayjs(string.replace(' +0000', ''), 'YYYY-MM-DD HH:mm:ss').toDate() : '',
	},
}
	
const extractMediaDetails = async (mediaUrl, snap, db) => {
	let details = {
		id: null,
		type: null,
	}

	if (!mediaUrl) {
		return;
	}

	if (mediaUrl.includes('youtube')) {
		details = {
			id: getIdFromYoutubeUrl(mediaUrl),
			type: 'youtube'
		}
	}

	if (mediaUrl.includes('spotify')) {
		details = {
			id: getIdFromSpotifyUrl(mediaUrl),
			type: 'spotify'
		}
	}

	if (mediaUrl.includes('bandcamp')) {
		details = {
			id: getIdFromBandcampUrl(mediaUrl),
			type: 'bandcamp'
		}
	}

	const mediaRef = db.collection('media').doc(createId(`${details.type}_${details.id}`));
	const doc = await mediaRef.get();

	if (!doc.exists) {
		mediaRef.set({
			...details,
			url: mediaUrl,
		});
	}

	await snap.ref.set({
		media: mediaRef,
	}, { merge: true })
}

const extractAdditionalMeta = async (snap, db) => {
	const { source, url } = snap.data();
	
	if (source === 'bleep') {
		return;
	}

	const requiresDateSearch = DATE_SELECTORS[source];

	const response = await scrapeIt(url, {
		embed: EMBED_SELECTORS[source],
		...(requiresDateSearch ? { date: DATE_SELECTORS[source] } : {}),
	});

	const { embed, date } = response.data;
	extractMediaDetails(embed, snap, db);

	if (requiresDateSearch) {
		await snap.ref.update({ date }, { merge: true })
	}
}

const submitResults = async(results, db) => {
	const batch = db.batch();

	let lastScrapeTimestamp = null;
	const settingsRef = db.collection('settings').doc('timestamps');

	try {
		const doc = await settingsRef.get()
		if (doc.exists) {
			const { lastScrape } = doc.data();
			lastScrapeTimestamp = lastScrape
		}
	} catch (error) {
		console.error('Error retrieving last scrape timestamp', error);
	}

	results.map(posts => {
		posts.map(post => {
			const { artists, date, title, type } = post;
			if (lastScrapeTimestamp && (!date || date < lastScrapeTimestamp)) {
				return;
			}

			const ref = db.collection('posts').doc();
			
			const isAlbum = type === 'album';
			const isTrack = type === 'track';

			let workRef = null;
			const artistRefs = artists.map((artist, index) => {
				const artistRef = db.collection('artists').doc(createId(artist))
				batch.set(artistRef, { name: artist }, { merge: true });

				if (index !== 0) {
					batch.update(artistRef, {
						featured: admin.firestore.FieldValue.arrayUnion(workRef)
					});

					return artistRef;
				}

				if (isAlbum) {
					workRef = artistRef.collection('albums').doc(createId(title));	
				}
				
				if (isTrack) {
					workRef = artistRef.collection('tracks').doc(createId(title));
				}
				
				batch.set(workRef, { name: title }, { merge: true });

				return artistRef;
			});

			batch.set(ref, {
				...post,
				artists: artistRefs,
				...(isAlbum ? {
					album: workRef,
				} : {
					track: workRef,
				}),
			});
		})
	})

	batch.set(settingsRef, {
		'lastScrape': Date.now()
	}, { merge: true })

	await batch.commit();
}

const updatePostsDatabase = async (db) => {
	const scraperPromises = [
		//scrapeBleep(),
		scrapeGvb(),
		scrapeStereogum(),
		scrapePitchforkTracks(),
		//scrapePitchforkAlbums()
	];
	const results = await Promise.all(scraperPromises)
	await submitResults(results, db);
};

module.exports = {
	extractAdditionalMeta,
	extractMediaDetails,
	updatePostsDatabase,
}