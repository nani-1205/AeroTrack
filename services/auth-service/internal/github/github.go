// Package github implements the GitHub OAuth web flow and profile lookup.
// All URLs come from config (auth.github.*), which also lets tests point at a fake server.
package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"golang.org/x/oauth2"

	"aerotrack/auth-service/internal/config"
)

type Profile struct {
	ID        int64   `json:"id"`
	Login     string  `json:"login"`
	Name      *string `json:"name"`
	Email     *string `json:"email"`
	AvatarURL *string `json:"avatar_url"`
}

type Client struct {
	oauth   *oauth2.Config
	apiBase string
	http    *http.Client
}

func New(cfg config.GitHub) *Client {
	return &Client{
		oauth: &oauth2.Config{
			ClientID:     cfg.ClientID,
			ClientSecret: cfg.ClientSecret,
			RedirectURL:  cfg.CallbackURL,
			Scopes:       cfg.Scopes,
			Endpoint: oauth2.Endpoint{
				AuthURL:   cfg.AuthorizeURL,
				TokenURL:  cfg.TokenURL,
				AuthStyle: oauth2.AuthStyleInParams,
			},
		},
		apiBase: strings.TrimRight(cfg.APIBaseURL, "/"),
		http:    &http.Client{Timeout: 10 * time.Second},
	}
}

// AuthCodeURL is where the browser is sent to approve the login.
func (c *Client) AuthCodeURL(state string) string {
	return c.oauth.AuthCodeURL(state, oauth2.SetAuthURLParam("allow_signup", "true"))
}

// FetchProfile exchanges the authorization code and loads the user's profile
// (falling back to the primary verified email when the public email is hidden).
func (c *Client) FetchProfile(ctx context.Context, code string) (Profile, error) {
	ctx = context.WithValue(ctx, oauth2.HTTPClient, c.http)
	tok, err := c.oauth.Exchange(ctx, code)
	if err != nil {
		return Profile{}, fmt.Errorf("exchange code: %w", err)
	}
	api := c.oauth.Client(ctx, tok)

	var p Profile
	if err := c.getJSON(ctx, api, "/user", &p); err != nil {
		return Profile{}, err
	}
	if p.ID == 0 || p.Login == "" {
		return Profile{}, errors.New("github: profile missing id/login")
	}
	if p.Email == nil || *p.Email == "" {
		var emails []struct {
			Email    string `json:"email"`
			Primary  bool   `json:"primary"`
			Verified bool   `json:"verified"`
		}
		// Needs the user:email scope; a failure here is not fatal.
		if err := c.getJSON(ctx, api, "/user/emails", &emails); err == nil {
			for _, e := range emails {
				if e.Primary && e.Verified {
					email := e.Email
					p.Email = &email
					break
				}
			}
		}
	}
	return p, nil
}

func (c *Client) getJSON(ctx context.Context, api *http.Client, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.apiBase+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "AeroTrack-auth-service")
	res, err := api.Do(req)
	if err != nil {
		return fmt.Errorf("github %s: %w", path, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("github %s: HTTP %d: %s", path, res.StatusCode, strings.TrimSpace(string(body)))
	}
	return json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(out)
}
