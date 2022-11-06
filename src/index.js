async function handleRequest(event) {
  const request = event.request;
  console.log(`Handling request for: ${request.url}`);

  const targetUrl = new URL(request.url);
  // abort if S3_BUCKET is not defined
  try {
    targetUrl.hostname = S3_BUCKET;
  } catch (e) {
    return new Response("S3_BUCKET is not defined", { status: 500 });
  }

  // if the pathname is /, just proxy without caching
  if (targetUrl.pathname === "/") {
    console.log(`Proxying request for: ${targetUrl}`);
    // warning: fetch needs a string, not a URL object
    return fetch(targetUrl.toString());
  }

  // otherwise, use the getLatestVersion function
  return getLatestVersion(targetUrl);
}

async function getLatestVersion(url) {
  const cache = caches.default;
  const cachedResponse = await cache.match(url);
  const index_hash = await crypto.subtle.digest(
    {
      name: "SHA-256",
    },
    // the url pathname as an array buffer
    new TextEncoder().encode(url.pathname)
  );

  // if not found, just run the _updateCachedVersion function
  if (!cachedResponse) {
    console.log(`Cache miss for: ${url}`);
    let response = await _updateCachedVersion(url);

    // add datapoint
    REQUESTS_V2.writeDataPoint({
      blobs: ["cache-miss"],
      // store the response size in the doubles array
      doubles: [0],
      index: [index_hash],
    });

    return response;
  }

  // if we have a cached response, check if it's still valid using a HEAD request.
  const cachedHeaders = cachedResponse.headers;
  const etag = cachedHeaders.get("etag");
  const modifiedSince = cachedHeaders.get("last-modified");

  const headRequest = new Request(url, {
    method: "HEAD",
    headers: { "if-none-match": etag, "if-modified-since": modifiedSince },
  });
  const headResponse = await fetch(headRequest);

  // if the response is 304, we can return the cached response
  if (headResponse.status === 304) {
    console.log(`Cache hit for: ${url} etag: ${etag}`);
    // add datapoint
    REQUESTS_V2.writeDataPoint({
      blobs: ["cache_hit"],
      // store the response size in the doubles array
      doubles: [1],
      indexes: [index_hash],
    });
    return cachedResponse;
  }

  // otherwise, we need to update the cache
  console.log(`Cache invalidation for: ${url} etag: ${etag}`);
  return await _updateCachedVersion(url);
}

async function _updateCachedVersion(url) {
  const cache = caches.default;

  console.log(`Updating cache for: ${url}`);

  const response = await fetch(url.toString());

  // important, do not cache the response if the status is not 200
  if (response.status !== 200) {
    console.error(`url: ${url} returned status: ${response.status}`);
    return response;
  }

  // copy over the etag, last-modified and content-size headers
  const headers = { "cache-control": "public, max-age=14400" };
  const etag = response.headers.get("etag");
  if (etag) {
    headers["etag"] = etag;
  }
  const modifiedSince = response.headers.get("last-modified");
  if (modifiedSince) {
    headers["last-modified"] = modifiedSince;
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    headers["content-length"] = contentLength;
  }

  const updatedResponse = new Response(response.body, {
    ...response,
    headers,
  });

  await cache.put(url, updatedResponse.clone());
  console.log(`Cache updated for: ${url}. etag: ${etag}`);

  return updatedResponse;
}

addEventListener("fetch", (event) => {
  try {
    return event.respondWith(handleRequest(event));
  } catch (e) {
    console.error(e);
    return event.respondWith(new Response("Error thrown " + e.message));
  }
});
