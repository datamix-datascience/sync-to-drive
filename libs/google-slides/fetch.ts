import * as core from "@actions/core";
import { google, slides_v1 } from "googleapis"; // Import slides_v1
import { JWT } from 'google-auth-library'; // Import JWT type if needed

// Re-use the authenticated client from drive/auth.ts
// We assume the 'auth' object exported from there includes the necessary Slides scope.

/**
 * Fetches the content of a Google Slides presentation using the Slides API.
 *
 * @param authClient - Authenticated JWT client with Slides API scope.
 * @param presentation_id - The ID of the Google Slides presentation.
 * @returns The presentation object JSON, or null if fetch fails.
 */
export async function fetch_google_slide_json(
  authClient: JWT, // Use the specific JWT type
  presentation_id: string
): Promise<slides_v1.Schema$Presentation | null> {
  core.info(`   - Fetching Google Slides content for ID: ${presentation_id}`);
  const slides = google.slides({ version: "v1", auth: authClient });

  try {
    const response = await slides.presentations.get({
      presentationId: presentation_id,
      // You might need specific fields later, but getting the whole object is often easiest
      // fields: "slides,pageSize,title" // Example specific fields
    });

    if (response.data) {
      core.info(`   - Successfully fetched Slides content for ID: ${presentation_id}`);
      return response.data;
    } else {
      core.warning(`   - Slides API returned no data for presentation ID: ${presentation_id}`);
      return null;
    }
  } catch (error: unknown) {
    const err = error as any; // Cast to access potential properties
    core.error(`   - Failed to fetch Google Slides content for ID ${presentation_id}: ${err.message}`);
    if (err.response?.data) {
      core.error(`   - Slides API Error Details: ${JSON.stringify(err.response.data)}`);
    }
    if (err.code) core.error(`   - Error Code: ${err.code}`);
    return null;
  }
}
