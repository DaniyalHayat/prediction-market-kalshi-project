# Bounded catalog loading

The initial category request and visible-page catalog refresh now have a 20-second end-to-end deadline. A stalled response produces a readable error with the existing Try again action, clears the loading state and preserves the existing list during a failed refresh. Switching category or unmounting still cancels the request without showing an error for the abandoned selection.

The shared JSON transport also has a 65-second default ceiling for other requests. More specific existing caller deadlines remain effective. The deadline covers both the wait for response headers and consumption of the JSON body, and is cleared after completion. HTML responses, malformed JSON and excessive response bodies retain their existing validation.

This bounds the interface's wait; it does not establish the cause of any particular production outage or substitute for checking the deployed frontend/backend revision, backend address, health and upstream connectivity. There is no retry loop or synthetic market fallback. Actual local HTTP tests exercise servers that never send headers and servers that send partial JSON without finishing; both return typed timeout errors. Normal JSON succeeds and explicit caller cancellation remains an AbortError.
